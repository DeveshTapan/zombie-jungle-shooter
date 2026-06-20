const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d", { alpha: false });
const ui = Object.fromEntries([
  "time", "score", "combo", "lives", "pauseBtn", "muteBtn", "startScreen",
  "pauseScreen", "endScreen", "startBtn", "resumeBtn", "restartBtn",
  "restartPauseBtn", "bestScore", "endEyebrow", "endTitle", "endCopy",
  "finalScore", "finalKills", "finalAccuracy", "damageFlash", "announcer",
  "sfxVolume", "musicVolume", "reducedMotion", "threatStrip", "threatLabel", "threatBar"
].map(id => [id, document.getElementById(id)]));

const WORLD = { w: 1280, h: 720, ground: 625, duration: 30 };
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => Math.random() * (b - a) + a;
const chance = p => Math.random() < p;

const background = new Image();
background.src = "assets/images/jungle-arena.webp";

const state = {
  mode: "menu",
  elapsed: 0,
  score: 0,
  kills: 0,
  shots: 0,
  hits: 0,
  combo: 1,
  comboTimer: 0,
  lives: 3,
  spawnClock: .7,
  shake: 0,
  flash: 0,
  last: performance.now(),
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  best: Number(localStorage.getItem("zjs-best") || 0)
};

const input = { left: false, right: false, jump: false, aim: false, fire: false };
const player = {
  x: 640, y: WORLD.ground, vx: 0, vy: 0, w: 42, h: 82, facing: 1,
  grounded: true, invulnerable: 0, fireClock: 0, runCycle: 0, recoil: 0
};

let bullets = [];
let enemies = [];
let particles = [];
let casings = [];
let floaters = [];

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.music = null;
    this.muted = false;
    this.musicClock = 0;
    this.stepClock = 0;
    this.ambientClock = 0;
  }
  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.music = this.ctx.createGain();
    this.master.gain.value = 1;
    this.sfx.gain.value = Number(ui.sfxVolume.value);
    this.music.gain.value = Number(ui.musicVolume.value);
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.master.connect(this.ctx.destination);
  }
  tone(freq, duration, { type = "sine", gain = .1, end = freq, bus = this.sfx, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), t + duration);
    amp.gain.setValueAtTime(.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + .008);
    amp.gain.exponentialRampToValueAtTime(.0001, t + duration);
    osc.connect(amp); amp.connect(bus || this.sfx);
    osc.start(t); osc.stop(t + duration + .02);
  }
  noise(duration, gain = .08, filter = 900, delay = 0) {
    if (!this.ctx || this.muted) return;
    const size = Math.ceil(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    const bp = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const t = this.ctx.currentTime + delay;
    src.buffer = buffer;
    bp.type = "bandpass"; bp.frequency.value = filter; bp.Q.value = .7;
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(.0001, t + duration);
    src.connect(bp); bp.connect(amp); amp.connect(this.sfx);
    src.start(t); src.stop(t + duration);
  }
  shoot() {
    this.tone(150, .13, { type: "sawtooth", gain: .18, end: 45 });
    this.tone(820, .055, { type: "square", gain: .055, end: 160 });
    this.noise(.09, .14, 1350);
  }
  hit(heavy = false) {
    this.tone(heavy ? 95 : 170, .1, { type: "square", gain: .08, end: 55 });
    this.noise(.06, .07, 500);
  }
  kill(type) {
    this.tone(type === "tank" ? 65 : 105, .22, { type: "sawtooth", gain: .09, end: 35 });
  }
  hurt() {
    this.tone(90, .3, { type: "sawtooth", gain: .15, end: 45 });
    this.noise(.18, .1, 300);
  }
  groan(heavy = false) {
    this.tone(heavy ? 62 : rand(78, 105), heavy ? .65 : .38, {
      type: "sawtooth", gain: heavy ? .055 : .025, end: heavy ? 38 : 54
    });
  }
  jump() { this.tone(180, .11, { gain: .045, end: 320 }); }
  ui(ok = true) { this.tone(ok ? 520 : 210, .08, { type: "square", gain: .035, end: ok ? 720 : 170 }); }
  step() { this.noise(.045, .018, 180); }
  update(dt, urgency, moving) {
    if (!this.ctx || this.muted || state.mode !== "playing") return;
    this.musicClock -= dt;
    if (this.musicClock <= 0) {
      const beat = lerp(.62, .28, urgency);
      this.musicClock = beat;
      const root = urgency > .65 ? 55 : 48;
      this.tone(root, .26, { type: "triangle", gain: .06, end: root * .82, bus: this.music });
      if (urgency > .45) this.tone(root * 2, .07, { type: "square", gain: .018, end: root * 1.7, bus: this.music, delay: beat / 2 });
    }
    this.stepClock -= dt;
    if (moving && player.grounded && this.stepClock <= 0) {
      this.stepClock = .24;
      this.step();
    }
    this.ambientClock -= dt;
    if (this.ambientClock <= 0) {
      this.ambientClock = rand(1.8, 4.2);
      this.tone(rand(2100, 3100), .07, {
        type: "sine", gain: .008, end: rand(2600, 3800), bus: this.music
      });
      if (chance(.35)) this.noise(.45, .006, 220);
    }
  }
  toggleMute() {
    this.init();
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, .03);
    ui.muteBtn.textContent = this.muted ? "×" : "♪";
    ui.muteBtn.setAttribute("aria-label", this.muted ? "Unmute sound" : "Mute sound");
  }
}

const audio = new AudioEngine();

const ENEMY_TYPES = {
  walker: { hp: 2, speed: 82, w: 47, h: 76, score: 100, color: "#73a74c" },
  runner: { hp: 1, speed: 150, w: 42, h: 68, score: 150, color: "#b6b14a" },
  tank: { hp: 7, speed: 47, w: 70, h: 102, score: 450, color: "#527b4b" },
  dropper: { hp: 2, speed: 95, w: 44, h: 70, score: 200, color: "#5c9c7d" }
};

function resetGame() {
  Object.assign(state, {
    mode: "playing", elapsed: 0, score: 0, kills: 0, shots: 0, hits: 0,
    combo: 1, comboTimer: 0, lives: 3, spawnClock: .75, shake: 0, flash: 0
  });
  Object.assign(player, {
    x: 640, y: WORLD.ground, vx: 0, vy: 0, facing: 1, grounded: true,
    invulnerable: 0, fireClock: 0, runCycle: 0, recoil: 0
  });
  bullets = []; enemies = []; particles = []; casings = []; floaters = [];
  closeScreens();
  updateHUD();
  audio.init();
  audio.ui();
  state.last = performance.now();
}

function closeScreens() {
  ui.startScreen.classList.remove("show");
  ui.pauseScreen.classList.remove("show");
  ui.endScreen.classList.remove("show");
}

function togglePause(force) {
  if (!["playing", "paused"].includes(state.mode)) return;
  const pause = force ?? state.mode === "playing";
  state.mode = pause ? "paused" : "playing";
  ui.pauseScreen.classList.toggle("show", pause);
  ui.pauseBtn.textContent = pause ? "▶" : "Ⅱ";
  if (pause) ui.resumeBtn.focus();
  else {
    state.last = performance.now();
    canvas.focus?.();
  }
  audio.ui(!pause);
}

function finish(won) {
  state.mode = "ended";
  const accuracy = state.shots ? Math.round(state.hits / state.shots * 100) : 0;
  if (state.score > state.best) {
    state.best = state.score;
    localStorage.setItem("zjs-best", String(state.best));
  }
  ui.endEyebrow.textContent = won ? "EXTRACTION WINDOW OPEN" : "BASE CAMP OVERRUN";
  ui.endTitle.textContent = won ? "CLEARING HELD" : "MISSION FAILED";
  ui.endCopy.textContent = won
    ? "You held the line until extraction. The jungle is quiet—for now."
    : "The infected broke through. Reload, reposition, and take the clearing back.";
  ui.finalScore.textContent = state.score.toLocaleString();
  ui.finalKills.textContent = state.kills;
  ui.finalAccuracy.textContent = `${accuracy}%`;
  ui.endScreen.classList.add("show");
  ui.bestScore.textContent = String(state.best).padStart(5, "0");
  setTimeout(() => ui.restartBtn.focus(), 100);
  audio.ui(won);
}

function spawnEnemy() {
  const difficulty = state.elapsed / WORLD.duration;
  const roll = Math.random();
  let type = "walker";
  if (difficulty > .2 && roll < .18 + difficulty * .12) type = "runner";
  if (difficulty > .45 && roll > .9 - difficulty * .06) type = "tank";
  if (difficulty > .3 && roll > .64 && roll < .76) type = "dropper";
  const spec = ENEMY_TYPES[type];
  const side = chance(.5) ? -1 : 1;
  const enemy = {
    type, hp: spec.hp, maxHp: spec.hp, speed: spec.speed * rand(.9, 1.12),
    w: spec.w, h: spec.h, x: side < 0 ? -80 : WORLD.w + 80,
    y: WORLD.ground, vx: 0, vy: 0, side, hit: 0, attackClock: 0,
    cycle: rand(0, TAU), airborne: type === "dropper"
  };
  if (type === "dropper") {
    enemy.x = rand(130, WORLD.w - 130);
    enemy.y = -90;
    enemy.vy = 220;
  }
  enemies.push(enemy);
  if (chance(type === "tank" ? 1 : .28)) audio.groan(type === "tank");
  if (type === "tank") {
    ui.announcer.textContent = "Heavy infected approaching.";
    audio.tone(52, .8, { type: "sawtooth", gain: .09, end: 38 });
  }
}

function fire() {
  if (player.fireClock > 0 || state.mode !== "playing") return;
  player.fireClock = .105;
  player.recoil = 1;
  state.shots++;
  const angle = input.aim ? -Math.PI / 2 : (player.facing > 0 ? 0 : Math.PI);
  const spread = rand(-.022, .022);
  const a = angle + spread;
  const muzzleX = player.x + (input.aim ? player.facing * 8 : player.facing * 39);
  const muzzleY = player.y - (input.aim ? 72 : 51);
  bullets.push({
    x: muzzleX, y: muzzleY, px: muzzleX, py: muzzleY,
    vx: Math.cos(a) * 980, vy: Math.sin(a) * 980, life: .85
  });
  for (let i = 0; i < 6; i++) {
    particles.push({
      x: muzzleX, y: muzzleY, vx: Math.cos(a) * rand(80, 220) + rand(-35, 35),
      vy: Math.sin(a) * rand(80, 220) + rand(-35, 35), life: rand(.06, .14),
      max: .14, size: rand(3, 8), color: chance(.5) ? "#fff2a2" : "#ff9d3c", glow: true
    });
  }
  casings.push({ x: player.x + player.facing * 8, y: player.y - 50, vx: -player.facing * rand(55, 95), vy: -rand(110, 170), life: 1 });
  if (!state.reducedMotion) state.shake = Math.max(state.shake, 2.5);
  audio.shoot();
}

function damageEnemy(enemy, index, x, y) {
  enemy.hp--;
  enemy.hit = .12;
  state.hits++;
  audio.hit(enemy.type === "tank");
  for (let i = 0; i < 9; i++) {
    particles.push({
      x, y, vx: rand(-130, 130), vy: rand(-180, 50), life: rand(.25, .55),
      max: .55, size: rand(2, 6), color: chance(.25) ? "#b7d957" : "#507a3d"
    });
  }
  if (enemy.hp <= 0) killEnemy(enemy, index);
}

function killEnemy(enemy, index) {
  enemies.splice(index, 1);
  state.kills++;
  state.combo = state.comboTimer > 0 ? Math.min(8, state.combo + 1) : 1;
  state.comboTimer = 2.25;
  const points = ENEMY_TYPES[enemy.type].score * state.combo;
  state.score += points;
  floaters.push({ x: enemy.x, y: enemy.y - enemy.h, text: `+${points}`, life: .9, color: state.combo > 2 ? "#d4ff54" : "#fff" });
  for (let i = 0; i < 22; i++) {
    particles.push({
      x: enemy.x, y: enemy.y - enemy.h * .45, vx: rand(-190, 190), vy: rand(-250, 80),
      life: rand(.35, .9), max: .9, size: rand(3, 10),
      color: chance(.2) ? "#c6dc65" : chance(.5) ? "#4e753d" : "#243d2e"
    });
  }
  if (!state.reducedMotion) state.shake = enemy.type === "tank" ? 11 : 5;
  audio.kill(enemy.type);
}

function hurtPlayer(enemy) {
  if (player.invulnerable > 0) return;
  state.lives--;
  player.invulnerable = 1.25;
  player.vy = -360;
  player.vx = player.x < enemy.x ? -280 : 280;
  state.combo = 1;
  state.comboTimer = 0;
  ui.damageFlash.classList.remove("hit");
  void ui.damageFlash.offsetWidth;
  ui.damageFlash.classList.add("hit");
  if (navigator.vibrate) navigator.vibrate([35, 30, 60]);
  if (!state.reducedMotion) state.shake = 15;
  audio.hurt();
  ui.announcer.textContent = `${state.lives} lives remaining.`;
  updateHUD();
  if (state.lives <= 0) finish(false);
}

function update(dt) {
  if (state.mode !== "playing") return;
  state.elapsed += dt;
  if (state.elapsed >= WORLD.duration) return finish(true);

  const difficulty = state.elapsed / WORLD.duration;
  state.spawnClock -= dt;
  if (state.spawnClock <= 0) {
    spawnEnemy();
    state.spawnClock = lerp(1.02, .38, difficulty) * rand(.8, 1.12);
    if (difficulty > .72 && chance(.23)) setTimeout(() => state.mode === "playing" && spawnEnemy(), 180);
  }

  player.fireClock = Math.max(0, player.fireClock - dt);
  player.invulnerable = Math.max(0, player.invulnerable - dt);
  player.recoil = Math.max(0, player.recoil - dt * 8);
  state.comboTimer = Math.max(0, state.comboTimer - dt);
  if (state.comboTimer <= 0) state.combo = 1;
  state.shake = Math.max(0, state.shake - dt * 28);

  const accel = player.grounded ? 1800 : 1150;
  const target = (Number(input.right) - Number(input.left)) * 285;
  player.vx += clamp(target - player.vx, -accel * dt, accel * dt);
  if (!input.left && !input.right && player.grounded) player.vx *= Math.pow(.001, dt);
  if (input.jump && player.grounded) {
    player.vy = -570;
    player.grounded = false;
    audio.jump();
  }
  input.jump = false;
  player.vy += 1450 * dt;
  player.x = clamp(player.x + player.vx * dt, 38, WORLD.w - 38);
  player.y += player.vy * dt;
  if (player.y >= WORLD.ground) {
    player.y = WORLD.ground;
    player.vy = 0;
    player.grounded = true;
  }
  if (Math.abs(player.vx) > 20) {
    player.facing = Math.sign(player.vx);
    player.runCycle += dt * Math.abs(player.vx) * .035;
  }
  if (input.fire) fire();

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.px = b.x; b.py = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    let consumed = b.life <= 0 || b.x < -50 || b.x > WORLD.w + 50 || b.y < -80 || b.y > WORLD.h + 30;
    if (!consumed) {
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        if (b.x > e.x - e.w / 2 && b.x < e.x + e.w / 2 && b.y > e.y - e.h && b.y < e.y) {
          damageEnemy(e, j, b.x, b.y);
          consumed = true;
          break;
        }
      }
    }
    if (consumed) bullets.splice(i, 1);
  }

  let tank = null;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.hit = Math.max(0, e.hit - dt);
    e.attackClock = Math.max(0, e.attackClock - dt);
    e.cycle += dt * e.speed * .035;
    if (e.airborne) {
      e.vy += 650 * dt;
      e.y += e.vy * dt;
      if (e.y >= WORLD.ground) {
        e.y = WORLD.ground;
        e.airborne = false;
        e.vy = 0;
        if (!state.reducedMotion) state.shake = 8;
        for (let p = 0; p < 12; p++) particles.push({
          x: e.x, y: WORLD.ground, vx: rand(-120, 120), vy: rand(-120, -35),
          life: rand(.25, .55), max: .55, size: rand(3, 8), color: "#8b8763"
        });
      }
    } else {
      const direction = Math.sign(player.x - e.x);
      e.x += direction * e.speed * dt;
      e.side = direction;
    }
    if (e.type === "tank") tank = e;
    const overlapX = Math.abs(player.x - e.x) < (player.w + e.w) * .42;
    const overlapY = player.y > e.y - e.h && player.y - player.h < e.y;
    if (overlapX && overlapY && e.attackClock <= 0) {
      e.attackClock = .7;
      hurtPlayer(e);
    }
  }

  ui.threatStrip.classList.toggle("hidden", !tank);
  if (tank) {
    ui.threatLabel.textContent = "HEAVY INFECTED";
    ui.threatBar.style.width = `${tank.hp / tank.maxHp * 100}%`;
  }

  updateEffects(dt);
  audio.update(dt, difficulty, Math.abs(player.vx) > 50);
  updateHUD();
}

function updateEffects(dt) {
  for (const p of particles) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 360 * dt; p.vx *= Math.pow(.2, dt); p.life -= dt;
  }
  particles = particles.filter(p => p.life > 0);
  for (const c of casings) {
    c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 500 * dt; c.life -= dt;
    if (c.y > WORLD.ground) { c.y = WORLD.ground; c.vy *= -.25; c.vx *= .65; }
  }
  casings = casings.filter(c => c.life > 0);
  for (const f of floaters) { f.y -= 45 * dt; f.life -= dt; }
  floaters = floaters.filter(f => f.life > 0);
}

function updateHUD() {
  ui.time.textContent = Math.max(0, Math.ceil(WORLD.duration - state.elapsed));
  ui.score.textContent = String(state.score).padStart(5, "0");
  ui.combo.textContent = `×${state.combo}`;
  ui.lives.innerHTML = Array.from({ length: 3 }, (_, i) => `<i class="life ${i >= state.lives ? "lost" : ""}"></i>`).join("");
  ui.lives.setAttribute("aria-label", `${state.lives} lives`);
}

function drawBackdrop(t) {
  if (background.complete && background.naturalWidth) {
    ctx.drawImage(background, 0, 0, WORLD.w, WORLD.h);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
    g.addColorStop(0, "#0c3b45"); g.addColorStop(1, "#07130f");
    ctx.fillStyle = g; ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  }
  ctx.fillStyle = "rgba(2, 14, 15, .18)";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  const pulse = .06 + Math.sin(t * .0012) * .018;
  const moon = ctx.createRadialGradient(770, 105, 10, 770, 105, 270);
  moon.addColorStop(0, `rgba(157, 232, 255, ${pulse})`);
  moon.addColorStop(1, "rgba(40, 120, 130, 0)");
  ctx.fillStyle = moon; ctx.fillRect(450, 0, 650, 450);
  ctx.fillStyle = "rgba(3, 14, 13, .32)";
  ctx.fillRect(0, WORLD.ground + 8, WORLD.w, WORLD.h - WORLD.ground);

  for (let i = 0; i < 8; i++) {
    const x = (i * 193 + t * (3 + i % 3)) % (WORLD.w + 80) - 40;
    const y = 150 + (i * 83) % 310 + Math.sin(t * .001 + i) * 10;
    ctx.fillStyle = `rgba(198, 255, 136, ${.12 + (i % 3) * .04})`;
    ctx.beginPath(); ctx.arc(x, y, 1.5 + i % 2, 0, TAU); ctx.fill();
  }
}

function drawPlayer() {
  const moving = Math.abs(player.vx) > 20 && player.grounded;
  const bob = moving ? Math.sin(player.runCycle * 2) * 2.5 : Math.sin(performance.now() * .004) * 1;
  const leg = moving ? Math.sin(player.runCycle) * 11 : 0;
  const alpha = player.invulnerable > 0 && Math.floor(player.invulnerable * 14) % 2 ? .35 : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(player.x, player.y + bob);
  ctx.scale(player.facing, 1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = "#121a1b"; ctx.lineWidth = 13;
  ctx.beginPath(); ctx.moveTo(-8, -27); ctx.lineTo(-10 + leg, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(8, -27); ctx.lineTo(10 - leg, 0); ctx.stroke();
  ctx.strokeStyle = "#3b4b4c"; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(-8, -27); ctx.lineTo(-10 + leg, -4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(8, -27); ctx.lineTo(10 - leg, -4); ctx.stroke();

  ctx.fillStyle = "#172427";
  ctx.beginPath(); ctx.roundRect(-22, -67, 44, 45, 9); ctx.fill();
  ctx.fillStyle = "#2c6870"; ctx.fillRect(-18, -62, 36, 12);
  ctx.fillStyle = "#d5ff54"; ctx.fillRect(-18, -53, 5, 22);
  ctx.fillStyle = "#31464a"; ctx.fillRect(-21, -43, 42, 9);

  ctx.fillStyle = "#c89670";
  ctx.beginPath(); ctx.arc(0, -78, 14, 0, TAU); ctx.fill();
  ctx.fillStyle = "#182528";
  ctx.beginPath(); ctx.arc(-2, -83, 15, Math.PI, TAU); ctx.fill();
  ctx.fillStyle = "#73e3ef"; ctx.fillRect(3, -80, 13, 5);

  const recoil = player.recoil * 7;
  ctx.save();
  ctx.translate(6 - recoil, input.aim ? -65 : -52);
  ctx.rotate(input.aim ? -Math.PI / 2 : 0);
  ctx.strokeStyle = "#c89670"; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(-4, 4); ctx.lineTo(20, 4); ctx.stroke();
  ctx.fillStyle = "#111b1d";
  ctx.beginPath(); ctx.roundRect(-5, -8, 48, 14, 4); ctx.fill();
  ctx.fillStyle = "#36535a"; ctx.fillRect(4, -10, 25, 5);
  ctx.fillStyle = "#7ee9f2"; ctx.fillRect(15, -7, 15, 2);
  ctx.fillStyle = "#1a292b"; ctx.fillRect(7, 5, 10, 13);
  ctx.fillStyle = "#87979a"; ctx.fillRect(40, -5, 13, 7);
  ctx.restore();
  ctx.restore();
}

function drawEnemy(e) {
  const s = ENEMY_TYPES[e.type];
  const direction = e.side || 1;
  const step = e.airborne ? 0 : Math.sin(e.cycle) * (e.type === "runner" ? 10 : 6);
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(direction, 1);
  if (e.hit > 0) ctx.filter = "brightness(2.2) saturate(.5)";
  if (!e.airborne) {
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.beginPath(); ctx.ellipse(0, 3, e.w * .55, 8, 0, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = "#17231e"; ctx.lineWidth = e.type === "tank" ? 18 : 11;
  ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-e.w * .16, -e.h * .36); ctx.lineTo(-e.w * .2 + step, -3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(e.w * .16, -e.h * .36); ctx.lineTo(e.w * .2 - step, -3); ctx.stroke();

  ctx.fillStyle = s.color;
  ctx.beginPath();
  ctx.roundRect(-e.w / 2, -e.h * .72, e.w, e.h * .46, e.type === "tank" ? 15 : 9);
  ctx.fill();
  ctx.fillStyle = "#253c31";
  ctx.fillRect(-e.w / 2, -e.h * .48, e.w, e.h * .12);
  if (e.type === "tank") {
    ctx.fillStyle = "#405b48";
    ctx.beginPath(); ctx.arc(-e.w * .38, -e.h * .63, 15, 0, TAU); ctx.arc(e.w * .38, -e.h * .63, 15, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#7b916b"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-18, -70); ctx.lineTo(15, -33); ctx.stroke();
  }
  ctx.fillStyle = s.color;
  ctx.beginPath(); ctx.arc(0, -e.h * .82, e.w * .27, 0, TAU); ctx.fill();
  ctx.fillStyle = "#cfff55";
  ctx.beginPath(); ctx.arc(7, -e.h * .84, e.type === "tank" ? 4 : 3, 0, TAU); ctx.fill();
  ctx.fillStyle = "#1a211a";
  ctx.fillRect(3, -e.h * .75, 14, 4);
  ctx.strokeStyle = s.color; ctx.lineWidth = e.type === "tank" ? 17 : 10;
  ctx.beginPath(); ctx.moveTo(-e.w * .38, -e.h * .62); ctx.lineTo(-e.w * .72, -e.h * .43 + step); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(e.w * .38, -e.h * .62); ctx.lineTo(e.w * .72, -e.h * .43 - step); ctx.stroke();

  if (e.hp < e.maxHp && e.type !== "tank") {
    ctx.fillStyle = "#160b0b"; ctx.fillRect(-e.w / 2, -e.h - 12, e.w, 4);
    ctx.fillStyle = "#d4ff54"; ctx.fillRect(-e.w / 2, -e.h - 12, e.w * e.hp / e.maxHp, 4);
  }
  ctx.restore();
}

function render(t) {
  ctx.save();
  const sx = state.reducedMotion ? 0 : rand(-state.shake, state.shake);
  const sy = state.reducedMotion ? 0 : rand(-state.shake, state.shake);
  ctx.translate(sx, sy);
  drawBackdrop(t);

  for (const c of casings) {
    ctx.fillStyle = "#d6af55";
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.life * 13); ctx.fillRect(-4, -1.5, 8, 3); ctx.restore();
  }
  for (const b of bullets) {
    const g = ctx.createLinearGradient(b.px, b.py, b.x, b.y);
    g.addColorStop(0, "rgba(255, 206, 81, 0)");
    g.addColorStop(1, "#fff5b6");
    ctx.strokeStyle = g; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(b.px - (b.x - b.px) * 2.5, b.py - (b.y - b.py) * 2.5); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  enemies.forEach(drawEnemy);
  drawPlayer();
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / (p.max || p.life), 0, 1);
    ctx.fillStyle = p.color;
    if (p.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = 10; }
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
  for (const f of floaters) {
    ctx.globalAlpha = clamp(f.life * 2, 0, 1);
    ctx.fillStyle = f.color;
    ctx.font = "800 24px Impact, 'Arial Narrow', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  const danger = 1 - state.lives / 3;
  if (danger > 0) {
    const vignette = ctx.createRadialGradient(WORLD.w / 2, WORLD.h / 2, 220, WORLD.w / 2, WORLD.h / 2, 760);
    vignette.addColorStop(0, "rgba(70,0,0,0)");
    vignette.addColorStop(1, `rgba(120,0,8,${danger * .3})`);
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  }
  ctx.restore();
}

function loop(now) {
  const dt = Math.min(.033, Math.max(0, (now - state.last) / 1000));
  state.last = now;
  update(dt);
  render(now);
  requestAnimationFrame(loop);
}

function mapKey(event, down) {
  const key = event.key.toLowerCase();
  if (["a", "arrowleft"].includes(key)) input.left = down;
  if (["d", "arrowright"].includes(key)) input.right = down;
  if (["e", "arrowdown"].includes(key)) input.aim = down;
  if ([" ", "j"].includes(key)) input.fire = down;
  if (down && ["w", "arrowup", "k"].includes(key)) input.jump = true;
  if (down && key === "p") togglePause();
  if (down && key === "m") audio.toggleMute();
  if (["a", "d", "w", "e", "j", "k", " ", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) event.preventDefault();
}

window.addEventListener("keydown", e => mapKey(e, true));
window.addEventListener("keyup", e => mapKey(e, false));
window.addEventListener("blur", () => {
  Object.keys(input).forEach(k => input[k] = false);
  if (state.mode === "playing") togglePause(true);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.mode === "playing") togglePause(true);
});

document.querySelectorAll("[data-action]").forEach(button => {
  const action = button.dataset.action;
  const set = down => {
    audio.init();
    button.classList.toggle("active", down);
    if (action === "jump") { if (down) input.jump = true; }
    else input[action] = down;
  };
  button.addEventListener("pointerdown", e => {
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    set(true);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(type =>
    button.addEventListener(type, e => { e.preventDefault(); set(false); })
  );
});

ui.startBtn.addEventListener("click", resetGame);
ui.restartBtn.addEventListener("click", resetGame);
ui.restartPauseBtn.addEventListener("click", resetGame);
ui.resumeBtn.addEventListener("click", () => togglePause(false));
ui.pauseBtn.addEventListener("click", () => togglePause());
ui.muteBtn.addEventListener("click", () => audio.toggleMute());
ui.sfxVolume.addEventListener("input", () => {
  audio.init();
  audio.sfx.gain.setTargetAtTime(Number(ui.sfxVolume.value), audio.ctx.currentTime, .02);
});
ui.musicVolume.addEventListener("input", () => {
  audio.init();
  audio.music.gain.setTargetAtTime(Number(ui.musicVolume.value), audio.ctx.currentTime, .02);
});
ui.reducedMotion.checked = state.reducedMotion;
ui.reducedMotion.addEventListener("change", () => state.reducedMotion = ui.reducedMotion.checked);

ui.bestScore.textContent = String(state.best).padStart(5, "0");
updateHUD();
requestAnimationFrame(loop);
