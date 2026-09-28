# 模型品牌资源

图标只用于识别对应模型厂商；品牌及商标权归各自所有者。SVG 以本地资源导入，由 Vite 内嵌到最终 `admin.html`，运行时无远程图片请求。

| 品牌           | 文件               | 来源                                                                                                                                                 |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 混元 / Hunyuan | hunyuan.svg        | 2026-09-27 从 https://hunyuan.tencent.com/ 页面声明的 https://hunyuan-blog-web-prod-1258344703.cos.ap-guangzhou.myqcloud.com/logo.svg 获取，原样保留 |
| GLM / 智谱     | zhipu-color.svg    | 用户指定项目 `H:/小懿code/app/src/main/assets/icons/zhipu-color.svg`                                                                                 |
| MiniMax        | minimax-color.svg  | 用户指定项目同目录 `minimax-color.svg`                                                                                                               |
| Kimi           | kimi-color.svg     | 用户指定项目同目录 `kimi-color.svg`                                                                                                                  |
| DeepSeek       | deepseek-color.svg | 用户指定项目同目录 `deepseek-color.svg`                                                                                                              |

模型匹配在 `src/utils.js` 的 `vendor()`，展示组件为 `ModelLogo.vue`。图标在深浅主题下都使用独立白色底板，保留品牌原色及 Kimi 的黑色字形。未知品牌保留文字缩写，不伪造品牌标识。模型目录始终来自服务端，这些资源不会添加并不存在的模型。
