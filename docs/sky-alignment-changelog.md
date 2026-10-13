# 音遇 · 对齐《光遇》的优化实施记录

配套文档：[sky-alignment-review.md](./sky-alignment-review.md)（静态审查，含 30 项问题的分行定位）。
本文只记录**已经落地并实测验证过**的改动，以及过程中查出来的、原审查没有覆盖的真问题。

复现方式：`client/scripts/shot.mjs`（无头 Chrome + 原生 CDP 截图）与
`client/scripts/imgstats.mjs`（无依赖 PNG 指标对比）。用法见文末。

---

## 0. 三个「审查没看出来、只有跑起来才暴露」的真问题

这三个是本次最大的收获。它们都属于**静默失效**：不抛异常、不报 warning、
类型检查全绿，但画面上是错的。

### 0.1 composer 的 RT 开 MSAA 会让整个画面在某些昼夜相位下失效（P0）

**现象**：黄昏相位下整屏变成一块均匀暗色，地面/水/角色/道具全都不见了。

**排查过程**（值得记录，因为几次都指向了错误的结论）：

1. 先怀疑相机：读出来 `camera.position = (-4.85, 7.66, -0.76)`、
   `rotation.x = -2.822`、朝向角色 —— 完全正常。
2. 再怀疑几何没画：打开 `renderer.info`，**一帧 387 次 draw call、16.2 万三角面**，
   几何明明在画。
3. 控制台**一条 three/framebuffer 报错都没有**。
4. 查能力：`EXT_color_buffer_float` ✓、`EXT_color_buffer_half_float` ✓、
   `MAX_SAMPLES = 8` ✓、`checkFramebufferStatus` 报 `COMPLETE(36053)`、
   `gl.getError()` 报 `NO_ERROR`。**多采样本身完全合法。**
5. 差点被带偏：中途做了两次「MSAA 开/关」对比，结论是关掉就好了；
   但后来发现那两次截图**相隔一分钟、昼夜相位不同**（这张是黄昏、那张是入夜），
   差点把昼夜差异误判成 MSAA 的锅。做了背靠背同相位对照才确认。

**结论**：`composer.renderTarget1/2` 是 `HalfFloatType`，在其上设 `samples`
之后 resolve 出来的内容是错的 —— 而且**只在黄昏这类高动态范围的相位暴露**
（同相位关闭 MSAA：`lumaMean 0.31 / regions 0.39,0.19,0.13 / glowPct 3.18`；
开启 MSAA：`0.27 / 0.16,0.16,0.16 / 0.30`，等于整帧被降成一块）。

**修法**：不要给 composer 的 RT 开 MSAA，改成独立的 **SMAA 后处理 pass**。
它与 RT 格式无关，还能顺带处理着色器锯齿（草叶、披风边缘）。
注意顺序：three 的 `SMAAPass` 工作在 linear-srgb，**必须排在 `OutputPass` 之前**。

```
RenderPass → godRay ShaderPass → UnrealBloomPass → SMAAPass → OutputPass
```

> 附带发现：原代码的 `antialias: !mobile` 只作用于**默认帧缓冲**，
> 而场景是渲到 composer 自己的 offscreen RT 上的 ——
> 也就是说这个项目**原本一点抗锯齿都没有**。这是 SMAA 之外的净收益。

### 0.2 草地是「满地白色纸板」（P0，静态审查漏掉）

**现象**：漫山遍野一米高的不透明淡色卡片，是全画面最丑的一处。

**数值根因**（量化之后才清楚）：草叶尖色 `hi = vec3(0.58, 0.78, 0.42)`
是**线性空间**的值，Rec709 亮度 **0.711**；而地面（受光 toon 材质）渲染后
实测亮度约 **0.25** —— **草比地面亮 2.6 倍**。再加上四个叠加因素：

| 因素 | 原值 | 问题 |
|---|---|---|
| 片元 alpha | `vec4(col, 1.0)` | 完全不透明，没有羽化/镂空 |
| `side` | `DoubleSide` | 正反面都实体填充 |
| 叶尖收窄 | `x * (1 - k * 0.35)` | 只收到 65%，是个方头 |
| 实例缩放 | `0.75 + rand * 0.85` | 最高约 0.99m 高、0.48m 宽 |

**修法**：
- 叶尖真正收到 0（`taper = (1-k) * (0.5 + 0.5*min(1, k*4))`，做出叶形轮廓）；
- 颜色压到与地面同档：`lo = vec3(0.045,0.105,0.042)`（亮度 0.088）、
  `hi = vec3(0.165,0.305,0.115)`（亮度 0.261）；
- 叶片 0.09 × 0.30m、缩放 0.62~1.20 → 0.19~0.36m 高；簇数 420 → 1500、每簇 6~9 片；
- 每片加随机**倾角** `aTilt`（原来只有绕 y 的朝向，所以是一片片竖直的牌）；
- 摆动幅度 0.16 → 0.055（原来那片"纸板"在飘）。

**顺带修掉一个跨模块不一致**：草地着色器里的雾是**自己写死**的
（`uFogColor = #eecfa4`、密度 `0.0042`），而 `setDayPhase` 根本没同步过它 ——
夜里场景雾转暗蓝，草地却还朝亮米色淡出，会在草地上浮出一片片发亮的奶色斑块。
现在把雾状态放进共享的 `lightState`（`fogColor` / `fogDensity`），草地每帧同步。

### 0.3 `setDayPhase` 每帧都在分配对象（P2，主循环里的 GC 尖峰）

`setDayPhase` 由 `main.ts` **每帧**调用（`(serverNow % 600000) / 600000`），
而它每帧会新建约 8 个堆对象 + 6 次 hex 字符串解析：
`arcDir()` 返回 `new Vector3()`（2~4 个）、`new Color("#c9d6ff")`、
`SPEC_DAY.clone()`、`water.setPhase({...})` 的对象字面量、雾色 `.clone()`。

**修法**：全部提到闭包外做成复用临时量（`_sunD/_moonD/_down/_uTintNight/_spec/_silC/_waterPhase`），
`arcDir` 改成写到 `out` 参数。

---

## 1. 已落地的其他改动

### 1.1 共享基础设施

| 文件 | 内容 |
|---|---|
| `client/src/world/lightstate.ts` | 新增 `night` 之外还导出 `fogColor` / `fogDensity`（见 0.2）、`fxGain()` = `2.0 + night*1.4`、`fxColor(color, gain, out?)`。目的是让「越暗越靠自发光」成为**架构不变量**，而不是每个特效各写各的 |
| `client/src/world/fxtextures.ts`（新） | `softDotTexture()` / `softRingTexture()` / `softStreakTexture()` / `puffTexture()`，64×64 sRGB CanvasTexture、带缓存。替换纯色方块 |
| `client/src/world/toon.ts` | `brushTexture(repeat)` 改成按 repeat 缓存（原来重复调用会重复建纹理）；笔刷纹理去掉逐像素颗粒、只留 22 个低频斑块（原颗粒在 mipmap 下会闪）；新增 `desat()` / `setToonAnisotropy()`；`ToonKit.mat(color, vertexColors, brushRepeat)` —— `brushRepeat = 0` 可关掉贴图（角色不该带纸纹） |

### 1.2 角色模型（`client/src/avatar.ts`）

**兜帽：原来把整张脸吃掉了。** `phiLength = 0.62π`（≈112°）且只后仰 0.45rad，
半径 0.345 又略大于脸（0.32×1.06）→ 正面看整颗头是一颗米色球。
改为 `0.46π`（≈83°，帽檐停在眉线以上）+ 后仰 0.62rad + 略放大半径，
深色面具脸从帽檐下露出来。

**眼睛：原来是糊在一起的一整块白。** 半径 0.108 × 横向 1.12 = 半宽 0.121，
而两眼中心只隔 ±0.112 —— **两只眼在鼻梁处直接重叠**。
改为半径 0.062、`EYE_SX/SY/SZ = 1.06/1.75/0.62`、中心 ±0.115（留出明显间隙），
并把 z 从 0.225 提到 0.255（脸是 z 向压到 0.96 的椭球，该处表面在 z≈0.286，
否则眼珠会埋进脸里）。尺寸常量提出来给眨眼动画共用 ——
原来眨眼那行把 `1.12/1.66/0.6` 手抄了一遍，是改漏的隐患。

**眼睛亮度**：`#fffdf4` 线性亮度 0.98，而 bloom 阈值是 0.8，原本只是"勉强过线"。
乘 1.35 让它稳定泛光（composer 的 RT 是 HalfFloat，不会截断回 1.0）。

**披风：原来从背后把腿全挡住了。** 长 0.9 → 0.60（下摆从 y≈0.12 抬到大腿中段）、
宽 0.82 → 0.70（0.82 大于手臂外缘 ±0.358，正面看披风从身后支棱出来像块平板）、
肩锚点跨度 `k*0.82` → `k*0.66`。下摆从 `|sin(k*2.7π)|` 的 3 个高低不齐半波
（远看像被撕开的纸边）改成 4 个匀称扇贝。

**轮廓光统一到披风**：`patchRimMaterial` 原来硬判 `isMeshStandardMaterial`，
而披风是 `MeshToonMaterial`，所以整条披风没有任何边。
已验证 `meshtoon.glsl.js` 同样声明了 `varying vec3 vViewPosition`（L4/L42）
且带 `#include <fog_fragment>`（L113），注入点对两者都成立。

**头身比**：`headGroup.scale` 1.12 → 1.06。

### 1.3 顺手修掉的两处接口级 bug

- `scene.ts` 写 `fireflyMat.opacity` 是**彻底的 no-op**：three 的 `WebGLMaterials.js`
  对 `isShaderMaterial` 分支只设 `uniformsNeedUpdate`，**根本不读 `material.opacity`**。
  改成写 `uniforms.uOpacity.value`。原来的萤火虫是昼夜满亮、永不变化。
- `patchRimMaterial` 的类型窄化：写成 `A | B` 联合后 TS 会把对方的
  `isXxxMaterial` 标志位窄化成 `never`，必须用显式标志读取。

---

## 2. 实测对比

同一昼夜相位、同一视角下的指标（`imgstats.mjs`）：

| 指标 | 基线 `baseline-01-world.png` | 改造后 | 说明 |
|---|---|---|---|
| `edgeHardSoft` | 0.8835 | **0.2862** | 硬边占比大幅下降 = SMAA 生效 + 白纸板草消失 |
| `glowPct` | 1.029 | 0.321 | 下降是**预期的**：原来那 1.0 大部分是白色草卡片被当成"发光" |
| `lumaMean` | 0.2597 | 0.2609 | 整体亮度不变，说明没有靠调亮画面来"变好看" |
| draw calls / 帧 | — | 306~333 | 含全部后处理 pass（`info.autoReset` 已关，统计的是整帧） |

> 注意 `glowPct` 不能单独看：改造前它高，是因为草是亮的不透明色块。
> 这项指标要等特效系统的 HDR 增益落地后才会真实上升。

---

## 3. 尚未落地

- **特效自发光增益**（`particles/windlines/bursts/musicfx/beacons/voicefx`）：
  实测所有特效的线性亮度都低于 bloom 阈值 0.8
  （光尘 0.415 / 萤火虫 0.548 / 余烬 0.543 / 爆点 0.452），
  全项目只有 `#ffffff × 0.98` 的音符字形会泛光。修法是把自发光颜色乘以
  `lightState.fxGain()`（2.0~3.4）并配 `fxtextures` 的柔边贴图。
- **地形台地化 + 崖壁岩带 + 烘焙 AO**（需与 `water.ts:28-42` 的 GLSL 拷贝同步）。
- **水面细波 + 色彩空间 + 水底混合**。
- **道具摆放/合批/树冠**、**统一轮廓光**（已扩到角色披风，道具未做）、
  **天空霾带与星点**。
- **手感**（`physics/controls/touch/remote`）。

---

## 附：复现与验收方式

```powershell
cd client

# 1) 类型检查
npx tsc --noEmit

# 2) 截图（自动进入世界、屏蔽联机请求、可选推进 N 帧物理）
node scripts/shot.mjs --out "..\docs\evidence\x.png" --info --frames 120

# 3) 固定昼夜相位（每 600 秒一个循环，不固定就没法做 A/B）
#    用 --eval 把 setDayPhase 包一层，永久强制到黄昏（相位 0）
node scripts/shot.mjs --out "..\docs\evidence\x.png" --eval "const w=crescendo.world; if(!w.__o) w.__o=w.setDayPhase; w.setDayPhase=()=>w.__o(0); w.__o(0); return 'phase0';"

# 4) 把镜头绕到角色正前方看脸（默认三人称只能看到背影）
node scripts/shot.mjs --out "..\docs\evidence\front.png" --eval "const w=crescendo.world; const c=crescendo.controls; c.update=()=>{}; const cam=w.camera; const g=crescendo.selfAvatar.group; const th=c.state.yaw; cam.position.set(g.position.x+Math.sin(th)*2.2, g.position.y+1.05, g.position.z+Math.cos(th)*2.2); cam.lookAt(g.position.x, g.position.y+0.95, g.position.z); return 'front';"

# 5) 图像指标 A/B
node scripts/imgstats.mjs "..\docs\evidence\baseline-01-world.png" "..\docs\evidence\x.png"
```

`shot.mjs` 会把页面 console 的 error/warning 一并打印出来。
**这一步不能省** —— 本次 0.1 那个 MSAA 失效正是"没有任何报错"的那一类问题，
不看画面/不看指标是查不出来的。

---

# 追加（第二轮）：同一类 bug 又抓到两处，外加发光体系与斗篷

## 0.4 PHASES 表里的 `fogColor` / `fogDensity` 从来没被写进 `scene.fog`（P1）

**这是云海那一路在实测四个相位时顺手挖出来的**，不是静态审查看出来的。

`PHASES` 里每个相位的 `fogColor` / `fogDensity` 都给得很讲究
（黄昏 `#eecfa4` / .0046、夜 `#2a3354` / .0055、黎明 `#dcc4d4` / .0050、
白昼 `#cfe0e8` / .0038），但**没有任何代码把这两个值写进 `scene.fog`** ——
`HEAD` 与工作树都只读不写。

后果：昼夜循环改了天空、太阳、曝光、水面波光、云，**唯独没改雾**。
雾恒为黄昏的亮米色，到了深夜就是一层**发亮的奶色霾**糊住整片远景 ——
近处暗、远处更亮，方向完全是反的。

**修法**（`scene.ts` 的 `setDayPhase`）：
```ts
const fogNow = scene.fog as THREE.FogExp2;
mixC(a.fogColor, b.fogColor, fogNow.color);
fogNow.density = THREE.MathUtils.lerp(a.fogDensity, b.fogDensity, u);
```
实测夜间从 `#eecfa4 / .0046` 变为 `#2e3551 / .0055` ✓。
云海每帧读的是**现场** `scene.fog`，所以这一处修好之后它会自动跟随，不需要改云海。

## 0.5 半球光与环境光同样从来没被写进灯光（P1，夜景不成立的根因）

和 0.4 是**完全一样的漏法**：`PHASES` 里一直有
`hemiSky` / `hemiGround` / `hemiInt` / `ambientColor` / `ambientInt` 五组值，
而 `scene.ts:67-71` 建完 `HemisphereLight(0xffe2c0, 0x6a8fa0, 0.82)` 和
`AmbientLight(0x8a7bd0, 0.36)` 之后，**再没有任何代码写过它们**。

于是深夜的半球光还是白昼的 **0.82**、环境光还是 **0.36** ——
草地被照成和白昼一样的亮绿，只有篝火附近才像夜里。

这一处是"越暗越靠自发光"这条不变量不成立的**直接原因**：环境光不减，
自发光再怎么加也压不出对比。修好之后：

| 指标（强制深夜相位 0.25） | 修前 | 修后 |
|---|---|---|
| `lumaMean` | 0.1467 | **0.0673** |
| `darkPct` | 27.2 | **79.3** |
| `regions`（九宫格） | 0.135, 0.352, 0.200 | 0.046, 0.043, 0.040 |

实测 `hemiInt 0.5` / `hemiSky #515e95` / `ambInt 0.3` ✓，
夜景变成"篝火暖光池 + 四周真正沉下去的暗"。

> **教训（三次同一类问题）**：这个项目里凡是"表里定义了、但没人应用到运行时对象上"
> 的值，都是静默的 —— 类型检查全绿、不报错、不警告。核查这类表的办法是
> **逐个字段反查赋值点**，而不是读代码觉得"应该写了"。
> 已按这个办法过了一遍 `PHASES`，剩下的 `sunInt` / `sunColor` / `sky.*` /
> `water.*` 都确认有写入点。

## 0.6 全项目的特效都够不到 bloom 阈值（P0，发光体系）

bloom 的亮度高通作用在**线性、tone-map 之前**的值上，阈值 0.8。
而加法混合下一个光点的实际贡献是 `color × opacity × 闪烁`。逐项实测/计算：

| 特效 | 颜色线性亮度 | × opacity | × 闪烁峰值 | 实际峰值 | 过阈值？ |
|---|---|---|---|---|---|
| 光尘 | `#ffe9b8` = 0.830 | 0.35 | 1.00 | **0.29** | ✗ |
| 萤火虫 | `#e5ffb0` = 0.913 | 0.60 | 1.00 | **0.55** | ✗ |
| 余烬 | `#ffc07a` = 0.543 | 0.90 | — | **0.49** | ✗ |
| 音符字形 | `#ffffff` = 1.000 | 0.98 | — | **0.98** | ✓ |

**整个项目里只有音符字形会泛光**，其余"发光物"都只是"画了一个亮色圆点"。
这解释了为什么此前看到的高 `glowPct` 全是白纸板草在冒充。

**修法**：引入 `lightState.fxGain()` 作为唯一的总开关，把它乘进**颜色**（进 HDR），
而不是乘进 alpha。取值是算出来的：

```
0.830 × 0.5 × 1.0 × 2.0 = 0.83   ← 刚好压在阈值上，等于"永远差一点"
0.830 × 0.5 × 1.0 × 3.2 = 1.33   ← 稳定过阈值
```

所以 `fxGain() = 3.2 + night * 1.6`（白天 3.2、深夜 4.8），
并配 `fxtextures.ts` 的柔边贴图。

**`particles.ts` 同步修掉的三处**：
1. **`gl_PointSize = uSize * (140.0 / -mv.z)`** —— `140` 等于隐式假设画布高 280px
   （three 的 `PointsMaterial` 用的是 `height * 0.5`）。换成 `uSizePx` uniform，
   按 drawing buffer 高度等比缩放，720p 下数值不变。
2. **闪烁幅度 `0.10 ~ 1.00`** —— 大部分时间在阈值上下反复穿越，读起来是
   "忽明忽灭的斑点"。收窄到 `0.4 ~ 1.0`：一直在发光，只是明暗在呼吸。
3. **余烬用无贴图的 `PointsMaterial`** —— three 的 `points.glsl.js` 只在
   `#ifdef USE_MAP` 下采样 `gl_PointCoord`，所以它**渲染成实心方块**。
   补 `softDotTexture()`，并把 `mat.color` 每帧从基准色 `copy()` 后乘 `fxGain()`
   （绝不在原地累乘，那是指数爆炸）。

**实测**（强制深夜相位，同机位）：

| 指标 | 修前 | 修后 |
|---|---|---|
| `glowPct` | 0.248 | **1.029**（4.1×） |
| `hiPct` | 0.160 | 0.218 |
| `lumaMean` | 0.0673 | 0.1017 |
| `edgeHardSoft` | 0.2905 | 0.2050（辉光把硬边糊柔了） |

## 0.7 斗篷的两处尺度错误（`cape.ts`）

**(a) `rowLen` 拿"被裁过的下摆"当量尺。** 原来是从 column 0 的首末顶点实测 y 跨度
（`cape.ts:52`），而 `shapeCape` 恰好要把底边整条抬起来做扇贝 —— 量出来只有标称的
**73%**（0.0412 对 0.0563）。于是 `maxLen = row * rowLen * 1.45` 里那个"1.45 倍余量"
实际只剩 **1.06 倍**，披风在快速移动/强风下被提前锁直成硬板，布的拉伸与回弹全被吃掉。

改成取**未变形的标称行距** `geometry.parameters.height / (rows - 1)` —— 对
`PlaneGeometry(0.7, 0.6, 12, 14)` 得 0.042857，正好等于标称值 ✓，且免疫 `shapeCape` 的任何形变。

**(b) Verlet 的加速度项写成 `a·h²·60`，而 `h ≡ dt = 1/60`，于是 `h²·60 ≡ h`。**
也就是说真正施加的位移是 `a·h` 而不是 `a·h²`，**加速度被放大 60 倍** ——
只是靠 `avatar.ts` 里把 `gravity` 调成 6 来配平。

因为步长由累加器固定，行为上一直是对的，但这个 60 是**隐式**的：哪天有人把 `dt` 调成
`1/120` 去提高布料精度，重力和风会一起变成 4 倍，整件披风直接爆炸。
改成显式常数 `ACCEL = 60` 并按 `h²` 正确缩放 —— 在 `dt = 1/60` 下与原来**逐位相同**，
但常数看得见、且与 `dt` 解耦。

> 斗篷的"垂坠感"还受一个几何事实限制：布片宽 0.70、肩部钉点跨度只有 0.66，
> 横向几乎没有余量，静止时必然是平的。要做出《光遇》那种褶皱，得让布宽显著大于
> 钉点跨度（用多余布料换褶皱），这会同时加宽剪影 —— 属于需要视觉迭代的取舍，
> 本轮没动，列在待办里。
