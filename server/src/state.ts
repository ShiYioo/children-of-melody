import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * 岛上的一名听歌人。
 * 位置由客户端按地形采样后上报（MVP 采用客户端权威，服务端只做边界约束）。
 */
export class Player extends Schema {
  @type("string") name: string = "旅人";
  @type("number") x: number = 0;
  @type("number") y: number = 2;
  @type("number") z: number = 8;
  @type("number") ry: number = 0; // 朝向
  @type("uint8") mov: number = 0; // 0 静止 / 1 行走 / 2 奔跑
  @type("boolean") sit: boolean = false;
  @type("int16") trackId: number = -1; // -1 没在听；0-5 生成式曲库；100+ 自定义曲目(100+songId)
  @type("number") startedAt: number = 0; // 服务器纪元的开始播放时间(ms)
  @type("string") songName: string = ""; // 自定义曲目的显示名
  @type("uint8") hue: number = 0; // 披风色相 0-359
}

export class IslandState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
