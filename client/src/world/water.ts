import * as THREE from "three";

/**
 * 岛屿四周的海：轻浪、浅水透绿、深水入蓝，
 * 沿真实海岸线(在 GLSL 里复刻地形函数)画出发光的泡沫带。
 */
export function createWater(camera: THREE.Camera): { mesh: THREE.Mesh; update: (t: number) => void } {
  const SUN_DIR = new THREE.Vector3(-0.62, 0.17, -0.42).normalize();
  const FOG_COLOR = new THREE.Color("#eecfa4");
  const FOG_DENSITY = 0.0042;

  const mat = new THREE.ShaderMaterial({
    transparent: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR },
      uFogColor: { value: FOG_COLOR },
      uFogDensity: { value: FOG_DENSITY },
      uCamPos: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;

      // 采样三层正弦浪，法线用有限差分
      float waveH(vec2 p, float t) {
        float h = 0.0;
        h += sin(p.x * 0.14 + t * 0.7) * 0.09;
        h += sin(p.y * 0.11 - t * 0.55) * 0.09;
        h += sin((p.x + p.y) * 0.23 + t * 1.1) * 0.05;
        return h;
      }

      void main() {
        vec3 pos = position;
        vec2 xz = (modelMatrix * vec4(pos, 1.0)).xz;
        pos.y += waveH(xz, uTime);
        vWorld = (modelMatrix * vec4(pos, 1.0)).xyz;

        float e = 1.5;
        float hx = waveH(xz + vec2(e, 0.0), uTime) - waveH(xz - vec2(e, 0.0), uTime);
        float hz = waveH(xz + vec2(0.0, e), uTime) - waveH(xz - vec2(0.0, e), uTime);
        vNormal = normalize(vec3(-hx, 2.0 * e, -hz));

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform vec3 uCamPos;
      varying vec3 vWorld;
      varying vec3 vNormal;

      // ---- 地形高度场的 GLSL 复刻（与 heightfield.ts 保持一致）----
      float smoothstep_(float a, float b, float x) {
        float t = clamp((x - a) / (b - a), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
      }
      float terrainH(vec2 p) {
        float r = length(p);
        float ang = atan(p.y, p.x);
        float ef = 0.82 + 0.14 * sin(ang * 3.0 + 1.7) + 0.07 * sin(ang * 7.0 + 0.4);
        float rr = r / (58.0 * ef);
        if (rr >= 1.0) return -1.6 - (rr - 1.0) * 60.0;
        float h = 5.5 * pow(max(0.0, 1.0 - rr), 1.25) + 1.2;
        vec2 d = p - vec2(26.0, -28.0);
        h += 9.5 * exp(-dot(d, d) / 320.0);
        float n = 0.8 * sin(p.x * 0.16 + 2.1) * cos(p.y * 0.13 - 1.2)
                + 0.5 * sin(p.x * 0.31) * sin(p.y * 0.27 + 0.8);
        h += n * smoothstep_(7.0, 20.0, r);
        h = mix(h, 1.25, min(1.0, 1.15 * exp(-r * r / 72.0)));
        h = mix(h, -1.6, smoothstep_(0.86, 1.0, rr));
        return h;
      }

      void main() {
        float th = terrainH(vWorld.xz);
        float depth = clamp((0.55 - th) / 2.2, 0.0, 1.0); // 0 浅 1 深

        vec3 shallow = vec3(0.35, 0.80, 0.72);
        vec3 deep = vec3(0.07, 0.27, 0.50);
        vec3 col = mix(shallow, deep, smoothstep(0.05, 0.75, depth));

        // 视角天光反射
        vec3 V = normalize(uCamPos - vWorld);
        vec3 N = normalize(vNormal);
        float fres = pow(1.0 - max(dot(V, N), 0.0), 3.0);
        col = mix(col, vec3(1.0, 0.83, 0.62), fres * 0.45);

        // 夕阳的粼粼波光
        vec3 R = reflect(-V, N);
        float spec = pow(max(dot(R, uSunDir), 0.0), 90.0);
        col += vec3(1.0, 0.85, 0.62) * spec * 1.2;

        // 海岸泡沫：贴着地形 0.55 等高线的一条发光带
        float shoreline = 1.0 - smoothstep_(0.0, 0.5, abs(th - 0.55));
        float band = 0.5 + 0.5 * sin(depth * 26.0 - uTime * 2.2);
        float foam = shoreline * (0.55 + 0.45 * band);
        col = mix(col, vec3(1.0, 0.96, 0.88), foam * 0.75);

        // 与场景一致的指数雾
        float dist = length(uCamPos - vWorld);
        float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(700, 700, 100, 100), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.55;

  return {
    mesh,
    update: (t: number) => {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uCamPos.value.copy(camera.position);
    },
  };
}
