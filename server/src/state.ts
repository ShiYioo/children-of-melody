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
  @type("string") songUrl: string = ""; // 链接曲目的音频直链（只存字符串，不代理音频）
  @type("uint8") hue: number = 0; // 披风色相 0-359
  @type("string") avatar: string = "classic"; // 角色外观
  @type("string") handWith: string = ""; // 牵手对象 sessionId；空 = 单独一人
  @type("boolean") handLead: boolean = false; // 是否牵头（带着对方走/飞）
}

/** 放置在岛上的背包家具（椅子 / 双人秋千）。key = `${owner}:${kind}`，每人每件唯一 */
export class Furniture extends Schema {
  @type("string") owner: string = "";
  @type("uint8") kind: number = 0; // 0 椅子 / 1 双人秋千
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") ry: number = 0;
}

export class IslandState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Furniture }) furniture = new MapSchema<Furniture>();
}
