import * as THREE from "three";

/**
 * 云海：岛屿脚下一圈缓慢漂移的奶油色软云，
 * 天上再飘几缕薄薄的高卷云。
 */
function makeCloudTexture(): THREE.Texture {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255, 250, 240, 0.95)");
  g.addColorStop(0.45, "rgba(255, 246, 232, 0.55)");
  g.addColorStop(1, "rgba(255, 246, 232, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Cloud {
  mesh: THREE.Mesh;
  radius: number;
  angle: number;
  speed: number;
  bobPhase: number;
}

export function createClouds(): { group: THREE.Group; update: (t: number) => void } {
  const group = new THREE.Group();
  const tex = makeCloudTexture();
  const clouds: Cloud[] = [];

  const mkCloud = (radius: number, y: number, scale: number, opacity: number, speed: number) => {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      fog: true, // 让远云融入黄昏暖雾，不生硬
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.scale.set(scale, scale * 0.55, 1);
    const angle = Math.random() * Math.PI * 2;
    mesh.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    mesh.lookAt(0, y * 1.4, 0); // 微微朝向岛心，透视更好看
    group.add(mesh);
    clouds.push({ mesh, radius, angle, speed, bobPhase: Math.random() * 10 });
  };

  // 岛脚下的云海
  for (let i = 0; i < 30; i++) {
    mkCloud(75 + Math.random() * 200, -7 + Math.random() * 4.5, 26 + Math.random() * 55, 0.5 + Math.random() * 0.35, 0.004 + Math.random() * 0.006);
  }
  // 高空的薄卷云
  for (let i = 0; i < 7; i++) {
    mkCloud(140 + Math.random() * 260, 55 + Math.random() * 40, 70 + Math.random() * 80, 0.16 + Math.random() * 0.1, 0.002 + Math.random() * 0.003);
  }

  return {
    group,
    update: (t: number) => {
      for (const c of clouds) {
        c.angle += c.speed * 0.016;
        c.mesh.position.x = Math.cos(c.angle) * c.radius;
        c.mesh.position.z = Math.sin(c.angle) * c.radius;
        c.mesh.position.y += Math.sin(t * 0.2 + c.bobPhase) * 0.004;
      }
    },
  };
}
