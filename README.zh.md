# trail-render

把一段 GPX 轨迹渲染成 1080p 电影感俯瞰视频。无头浏览器里用 MapLibre 画卫星图
和 3D 地形，相机沿着平滑后的路线做匀速跟拍，每段起止做 smoothstep 缓入缓出，
转向带速率上限防止急弯甩镜头，最后 ffmpeg 把帧序列打成 H.264 MP4。

[English README](README.md) · [架构说明](docs/architecture.md) · [跳变调查记录](docs/residual-jumps-investigation.md) · [诊断工具索引](docs/tooling.md)

## 视频长什么样

- **Intro（前 9 秒）** — 从地球仪视角缩放到起点，国境线高亮。
- **Trail（主体）** — 相机匀速沿 GPX 跟拍（默认 0.5 秒/公里），到宿营点自动
  停留，每段进出都做 smoothstep 缓动，转向速率锁在 1.8°/帧以内，急弯不会甩镜头。
- **Finish（末尾 4 秒）** — 停在终点显示结束标签。

## 环境要求

- Node.js ≥ 20（用到原生 `fetch`、`AbortSignal.timeout`、顶层 `await`）。
- `ffmpeg` 在 PATH 上。macOS 用 `brew install ffmpeg`，Debian/Ubuntu 用
  `apt install ffmpeg`。
- MapTiler API key（免费额度够用）。去 <https://www.maptiler.com/> 注册，
  然后导出：
  ```sh
  cp .env.example .env      # 或者直接 export
  export MAPTILER_KEY=...
  ```
- Playwright 的 chromium（装一次即可）：
  ```sh
  npm install
  npx playwright install chromium
  ```

## 快速上手

```sh
# 渲染仓库根目录自带的 demo GPX
MAPTILER_KEY=... npm start activity_580930440.gpx

# 预览模式（只起服务不截图，方便本地调）
MAPTILER_KEY=... npm run preview activity_580930440.gpx
# 然后浏览器打开 http://localhost:3456

# 渲染自己的轨迹
MAPTILER_KEY=... npm start path/to/my-hike.gpx --output output/my-hike.mp4
```

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--fps N` | 30 | 输出帧率 |
| `--width N` / `--height N` | 1920 / 1080 | 输出分辨率 |
| `--output PATH` | `output/trail.mp4` | 最终 MP4 路径 |
| `--duration SECS` | auto | 覆盖总时长（自动 = 9s intro + 0.5s/km trail + 2s/停留点 + 4s finish） |
| `--title NAME` | 反向地理编码 | 起点标签 |
| `--end NAME` | 反向地理编码 | 终点标签 |
| `--name TRAIL_NAME` | 无 | intro 阶段显示的大标题 |
| `--preview` | 关 | 只起服务不截图 |

一条轨迹首次渲染时，脚本会并发拉 DEM 高程（Open-Meteo）、反向地理编码起点/
宿营点/终点（Nominatim）、就近 POI（Overpass）、国境线几何（Nominatim），然后
把结果写到 GPX 同目录的 `<gpx>.cache.json`。第二次起这些网络调用就全跳过了。

## 测试

两层，都已在干净 checkout 上验证通过：

```sh
npm test          # 33 个单测，~2 秒，无需任何凭证
npm run test:e2e  # 完整管线：渲染 demo GPX → MP4 → scene_score 回归，~3:30
```

单测跑在 `node:test`（无任何开发依赖），覆盖 `src/render-config.js` 的时长
计算、`src/parse-gpx.js` 直接吃仓库里那份 `activity_580930440.gpx`、
`src/lod-analysis.js` 的瓦片 diff 工具，以及 `scripts/regress.js` 里的
`bucket()`。所有纯函数都是直接 import 测，没有任何 mock。

e2e 测试（`test/e2e/render.test.js`）真的 spawn `src/index.js` 跑完整管线
渲染 demo GPX，先断言产物存在且大小合理，再调 `scripts/regress.js` 对比
`docs/regress-baseline.json`，任何 scene_score 回归都会让测试失败。它放在
子目录里，默认 `npm test`（glob 是 `test/*.test.js`）扫不到；
**没设 `MAPTILER_KEY` 时自动 skip**，CI / 冷克隆不会因此挂掉。

## 回归检查

相机参数和 LOD 相关改动都要跟 ffmpeg `scene_score` 基线比对
（指标是怎么建立的见 [`docs/residual-jumps-investigation.md`](docs/residual-jumps-investigation.md)）。
渲染完之后：

```sh
npm run regress output/my-render.mp4
```

任一阈值超限就 exit 非零：`peaks≥0.08` 不允许新增，`peaks≥0.05` 最多比基线
多 2 个，`peaks≥0.025` 最多多 5 个，max scene_score 最多涨 20%。确认新视频
确实没问题之后，再锁定新基线：

```sh
npm run regress output/my-render.mp4 -- --update-baseline
```

`npm run test:e2e` 就是把这个检查包在一次完整渲染外面的端到端版本 —— 想一键
验证"我这一改有没有破坏整个管线"用它就行。

## 目录结构

```
src/
  index.js            渲染主入口（CLI + 管线编排）
  render-config.js    共享的时长/节奏常量
  parse-gpx.js        GPX → 降采样点列 + 边界 + 宿营点检测
  server.js           给页面提供 trackData + config 的 express
  capture.js          Playwright 截图循环 + ffmpeg 编码
  lod-analysis.js     纯函数瓦片 diff 工具（detect-lod-jumps 和测试共用）
  detect-lod-jumps.js 带逐帧瓦片状态记录的 Playwright 扫描
  camera-sweep.js     离线相机参数扫描（不起浏览器）
  jitter-metric.js    相机平滑度定量基准
  benchmark.js        截图管线微基准

public/
  index.html          MapLibre 页面：图层、phase、预热、setFrame API
  camera/
    smooth-constant.js 当前相机策略（MA 平滑 + 匀速）

scripts/
  regress.js          scene_score 回归检查（被 npm run regress 调）

test/
  render-config.test.js  parse-gpx.test.js  lod-analysis.test.js  regress.test.js
  e2e/
    render.test.js    真跑完整管线的端到端测试

docs/
  architecture.md                   管线、phase 模型、LOD staging、相机接口
  tooling.md                        诊断脚本什么时候用哪个
  residual-jumps-investigation.md   指标怎么建立、修复怎么迭代的
  regress-baseline.json             提交在仓库里的 scene_score 基线
```

## 许可证

[MIT](LICENSE)
