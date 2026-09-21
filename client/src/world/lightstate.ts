import * as THREE from "three";

/**
 * 全局光照状态：scene.setDayPhase 每帧写入，渲染层（水面/云）与角色层
 * （披风透光/边缘光/接触阴影）都从这里读——避免 avatar 反向 import scene。
 */
export const lightState = {
  /** 太阳（夜=月亮）方向，指向光源 */
  sunDir: new THREE.Vector3(-0.62, 0.17, -0.42).normalize(),
  /** 夜晚度 0~1（0 纯白天 1 深夜） */
  night: 0,
};
