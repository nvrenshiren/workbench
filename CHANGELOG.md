# [0.6.0](https://github.com/nvrenshiren/opcflow/compare/v0.5.0...v0.6.0) (2026-07-09)


### Bug Fixes

* plan 取消语义接上 tombstone——已删除页面 PRD 按磁盘存在性收敛,不再派发且可取消 ([a0aab75](https://github.com/nvrenshiren/opcflow/commit/a0aab751ec93cd7b9e1b7aef03d9a81a83a90b80))
* rework 完成与复验 qa 派发并入同一事务,闭环不再有静默断裂窗口 ([37103c1](https://github.com/nvrenshiren/opcflow/commit/37103c187c58d5ed3a48f0e1b5c5aa3d49591405))
* sync 派复审去重改按目标粒度——首轮 review 未关时新增下游不再被静默漏通知 ([5977829](https://github.com/nvrenshiren/opcflow/commit/597782982686f462f9908006cca8cfae7116ee89))
* 协议 lint 门禁去外层角色白名单,role:qa/designer 等配置项不再被静默忽略 ([0e9c3c2](https://github.com/nvrenshiren/opcflow/commit/0e9c3c2ee15881be78be3a6b50ca5c4752e151bd))
* 树 health 两处失真——端级失败事件端节点自查;gate 阻塞识别覆盖全部 [前置条件] ([8f5f6e4](https://github.com/nvrenshiren/opcflow/commit/8f5f6e4cea9203c0156ce3a0f2d82c4879733a85))


### Features

* 新增 config.taskPreconditions 表达任务级跨角色前置,替换 QA 硬编码分支 ([3fde522](https://github.com/nvrenshiren/opcflow/commit/3fde522635ba8956810a107ba3b1a9726ad98f8b))

# [0.5.0](https://github.com/nvrenshiren/opcflow/compare/v0.4.0...v0.5.0) (2026-07-09)


### Bug Fixes

* 关系图控件跟随暗色主题;手动登记的产物可取消登记(无信任痕迹才放行) ([e603831](https://github.com/nvrenshiren/opcflow/commit/e603831fec004447673a85dd3ef581ea4ab0f2c2))


### Features

* artifact_edges 加 source 列区分推导边与手动边(迁移 4) ([cfe1980](https://github.com/nvrenshiren/opcflow/commit/cfe198062c6a4f71ea953baf6810bf39a3b8cb54))
* deriveEdges 对账化——derived 边随坐标事实收敛,manual 边永不动 ([f329524](https://github.com/nvrenshiren/opcflow/commit/f3295243ac4f09a68fd95ca4041caa6b4150c402))
* scan 重命名/移动检测——同 hash 唯一候选保 id 跟随,审批与关系存活 ([15f101c](https://github.com/nvrenshiren/opcflow/commit/15f101cf5dc652919c205706b22fe96384ce0daa))
* 关系图只读 API——graph/search/按需登记 ([4c9b157](https://github.com/nvrenshiren/opcflow/commit/4c9b15746a1f91bce6daeb567b963a5eda5c3165))
* 工作台产出物关系图——画布/搜索/手动连线/解绑/文件按需登记 ([7034d13](https://github.com/nvrenshiren/opcflow/commit/7034d13f15047e2fbc27df5457158a556ac48bd5))
* 手动关系边 API——建边(环检测)/解绑(仅 manual),事件留痕 ([ba0d9ae](https://github.com/nvrenshiren/opcflow/commit/ba0d9aec98cd786fab7427a600cafa370dcf9f48))

# [0.4.0](https://github.com/nvrenshiren/opcflow/compare/v0.3.0...v0.4.0) (2026-07-09)


### Bug Fixes

* HTML 原型 iframe 直接打开本地地址,相对资源正确解析 ([2b8d77f](https://github.com/nvrenshiren/opcflow/commit/2b8d77fd8d8de16a60d626ec803d6c692d4b5268))


### Features

* 坐标解析改为 config 可配的 coords 文法,支持自定义内层目录约定 ([e4fc3b2](https://github.com/nvrenshiren/opcflow/commit/e4fc3b2b80a184e4a6ada99e6d8c0a0520c0446b))

# [0.3.0](https://github.com/nvrenshiren/opcflow/compare/v0.2.1...v0.3.0) (2026-07-08)


### Features

* 经验提炼让 AI 判断沉淀为 skill/规则/记忆,阈值可配 ([eb12d33](https://github.com/nvrenshiren/opcflow/commit/eb12d33d3df60dc7b832c28742dbb717cf17da10))

## [0.2.1](https://github.com/nvrenshiren/opcflow/compare/v0.2.0...v0.2.1) (2026-07-08)


### Bug Fixes

* scan 收敛已登记行的坐标(moduleMapping/kind 漂移),不再需要删库重建 ([a10841a](https://github.com/nvrenshiren/opcflow/commit/a10841a6e10250b5cf164c0066f7dd883cb93b53))

# [0.2.0](https://github.com/nvrenshiren/opcflow/compare/v0.1.1...v0.2.0) (2026-07-08)


### Features

* 支持 opcflow -h/--help,无命令时打印帮助且不误建 .workbench ([2838c73](https://github.com/nvrenshiren/opcflow/commit/2838c73b4fcdd62c146b42b53e163a2b51c6d309))

## [0.1.1](https://github.com/nvrenshiren/opcflow/compare/v0.1.0...v0.1.1) (2026-07-08)


### Bug Fixes

* 规范 repository url 为 git+https 格式,消除 npm publish 警告 ([3ac6dc8](https://github.com/nvrenshiren/opcflow/commit/3ac6dc85aa4ec7215d72acda47a8d72f8b142c26))
