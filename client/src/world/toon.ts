import * as THREE from "three";

/**
 * 共享的 toon 材质工厂：四档色阶 + 材质缓存，
 * 让全岛道具保持同一种柔和的阶梯光影。
 */
export interface ToonKit {
  mat: (color: string, vertexColors?: boolean) => THREE.Material;
  dispose: () => void;
}

export function createToonKit(): ToonKit {
  // 四档亮度：亮面到暗面过渡干脆，形成卡通感
  const steps = new Uint8Array([110, 165, 215, 255]);
  const gradientMap = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.needsUpdate = true;

  const cache = new Map<string, THREE.Material>();
  return {
    mat(color, vertexColors = false) {
      const key = `${color}|${vertexColors}`;
      let m = cache.get(key);
      if (!m) {
        m = new THREE.MeshToonMaterial({
          color,
          gradientMap,
          vertexColors,
        });
        cache.set(key, m);
      }
      return m;
    },
    dispose() {
      gradientMap.dispose();
      cache.forEach((m) => m.dispose());
    },
  };
}
