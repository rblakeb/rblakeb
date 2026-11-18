// A simple animated face drawn on a canvas: it blinks, sways a little, and
// moves its mouth while the character is speaking. A stand-in for a realistic
// real-time avatar service, which would replace this canvas with a video track.

const LOOKS = {
  tutor: { skin: "#e7b98f", hair: "#3b2416", shirt: "#d9485f", bg: ["#2a3350", "#141a2c"], longHair: true },
  music: { skin: "#a8734f", hair: "#151515", shirt: "#3e7c6a", bg: ["#2f2a45", "#16131f"], longHair: false },
};

export class Avatar {
  constructor(canvas, character) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.look = LOOKS[character] ?? LOOKS.tutor;
    this.mouth = 0; // 0 closed .. 1 wide open
    this.mouthTarget = 0;
    this.speaking = false;
    this.nextBlink = performance.now() + 2000;
    this.blinkUntil = 0;
    this.running = true;
    this.lastMouthChange = 0;
    requestAnimationFrame((t) => this.frame(t));
  }

  setSpeaking(speaking) {
    this.speaking = speaking;
    if (!speaking) this.mouthTarget = 0;
  }

  // Called on each spoken word boundary, so the mouth closes briefly between words.
  wordBoundary() {
    this.mouthTarget = 0.1;
    this.lastMouthChange = performance.now();
  }

  stop() {
    this.running = false;
  }

  frame(t) {
    if (!this.running) return;
    if (this.speaking && t - this.lastMouthChange > 90) {
      this.mouthTarget = 0.25 + Math.random() * 0.75;
      this.lastMouthChange = t;
    }
    this.mouth += (this.mouthTarget - this.mouth) * 0.35;
    if (t > this.nextBlink) {
      this.blinkUntil = t + 120;
      this.nextBlink = t + 2500 + Math.random() * 3000;
    }
    this.draw(t, t < this.blinkUntil);
    requestAnimationFrame((next) => this.frame(next));
  }

  draw(t, blinking) {
    const { ctx, canvas, look } = this;
    const w = canvas.width;
    const h = canvas.height;
    const sway = Math.sin(t / 1400) * 6;
    const nod = Math.sin(t / 900) * (this.speaking ? 4 : 1.5);
    const cx = w / 2 + sway;
    const cy = h * 0.46 + nod;

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, look.bg[0]);
    bg.addColorStop(1, look.bg[1]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Shoulders
    ctx.fillStyle = look.shirt;
    ctx.beginPath();
    ctx.ellipse(w / 2 + sway * 0.5, h + 40, 220, 170, 0, Math.PI, 0);
    ctx.fill();

    // Neck
    ctx.fillStyle = look.skin;
    ctx.fillRect(cx - 35, cy + 90, 70, 80);

    // Long hair behind the head
    if (look.longHair) {
      ctx.fillStyle = look.hair;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 40, 135, 175, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Head
    ctx.fillStyle = look.skin;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 105, 130, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hair on top
    ctx.fillStyle = look.hair;
    ctx.beginPath();
    ctx.ellipse(cx, cy - 85, 112, 62, 0, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx - 20, cy - 75, 95, 40, -0.2, 0, Math.PI * 2);
    ctx.fill();

    // Eyes
    for (const dx of [-40, 40]) {
      if (blinking) {
        ctx.strokeStyle = "#2b1d14";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx + dx - 14, cy - 10);
        ctx.lineTo(cx + dx + 14, cy - 10);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(cx + dx, cy - 10, 16, 11, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3a2a1e";
        ctx.beginPath();
        ctx.arc(cx + dx + sway * 0.3, cy - 10, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      // Brows lift a little while talking
      ctx.strokeStyle = look.hair;
      ctx.lineWidth = 5;
      ctx.beginPath();
      const lift = this.speaking ? this.mouth * 4 : 0;
      ctx.moveTo(cx + dx - 18, cy - 34 - lift);
      ctx.quadraticCurveTo(cx + dx, cy - 42 - lift, cx + dx + 18, cy - 34 - lift);
      ctx.stroke();
    }

    // Nose
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 2);
    ctx.quadraticCurveTo(cx - 10, cy + 30, cx + 4, cy + 34);
    ctx.stroke();

    // Mouth: a smile when closed, an open oval while talking
    const open = this.mouth;
    ctx.fillStyle = "#6b2c2c";
    ctx.strokeStyle = "#8c3b3b";
    ctx.lineWidth = 4;
    if (open > 0.08) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + 66, 26, 4 + open * 18, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - 26, cy + 62);
      ctx.quadraticCurveTo(cx, cy + 78, cx + 26, cy + 62);
      ctx.stroke();
    }
  }
}
