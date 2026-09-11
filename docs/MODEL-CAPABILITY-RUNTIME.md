# 自定义模型能力运行时修复记录

> 实施日期：2026-09-11
>
> 目的：记录“供应商自定义模型已勾选视觉/思考，但实际请求仍被判定为不支持”的排查结论、修改范围和后续定位方法。

## 1. 问题现象

在供应商 `commandcode` 下添加 `deepseek/deepseek-v4.1-flash` 时，界面已经保存：

```json
{
  "vision": true,
  "reasoning": true
}
```

但通过 9router 发送带图片的请求时，仍然出现模型不支持视觉的提示，图片被转换为 `[image omitted: model has no vision support]`。本地数据库中的自定义模型记录是存在的，问题不在“保存”阶段，而在“请求执行”阶段没有读取这份能力配置。

后续验证发现，即使能力判断修复后，`glm-5.3-flash` 的视觉请求仍然可能没有识别结果。原因是 CommandCode 请求转换器曾经把 OpenAI `image_url` 块硬编码为 `[image omitted]`；也就是说，能力判断已经放行图片，但真正发往上游的请求仍然没有图片数据。

另外，Codex 的调试日志原先只统计 `image_url`，而 OpenAI→Responses 转换后实际使用的是 `input_image`，因此日志中的 `images=0` 不能作为“请求没有图片”的充分证据。Codex 的图片计数和远程图片预取现已同时兼容两种块类型。

## 2. 根因与调用链

此前运行时在 `open-sse/handlers/chatCore.js` 中直接调用：

```text
getCapabilitiesForModel(provider, model)
```

这个函数只读取静态供应商表、标准模型名规则和同步目录。`commandcode/deepseek/deepseek-v4.1-flash` 不在静态表的视觉模型精确项中，因此运行时得到 `vision: false`。后续 `stripUnsupportedModalities()` 依据这个静态结果移除了图片。

同一份静态能力结果还被 combo 自动排序、容量适配器、思考参数转换和 Claude 输出上限逻辑使用。因此只修复图片清洗会造成路由排序和请求转换状态不一致。

CommandCode `/alpha/generate` 的图片协议要求使用官方 CLI 风格的 base64 块：

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "..."
  }
}
```

## 3. 实施方案

### 3.1 能力覆盖的优先级

运行时（open-sse 热路径）与发现层（`/v1/models`）**共用同一个聚合入口** `resolveCapabilities()`（`src/lib/modelCapabilities.js`）。两边不得各自拼装能力，否则会出现「客户端被告知支持视觉、网关却把图静默剥掉」这类分歧。

每一次聊天请求生成一个独立的能力解析器，优先级如下（低 → 高，后者按字段覆盖前者）：

```text
1. getCapabilitiesForModel(provider, model)         静态供应商/模型能力表与名称规则
2. capabilitiesFromServiceKind(serviceKind)         自定义模型的服务类型派生能力
   liveCapabilities                                 供应商实时 /models 元数据
3. findBundledStandardModel(publicName)?.capabilities  内置标准模型权威目录
4. persisted                                        本地 DB（标准模型已声明能力 / 自定义模型 caps）
5. overrides                                        显式 mapping.capabilityOverrides
```

合并规则：

- 第 2 层起，所有来自 DB 或目录的值都先过 `normalizeCapabilityOverrides` 白名单，未识别的字段不会进入运行时。
- 目录与本地记录之间是**字段级**合并：本地只覆盖自己显式声明的字段，像 `{ tools: true }` 这样的部分对象不会遮蔽目录里的 `vision`。
- 显式声明 `{ vision: false }` 会被尊重，**不会**被当成「未声明」而回退成目录值。
- `resolveCapabilities` 是纯同步函数，调用方传入自己已经加载好的值；DB / 文件 IO 只发生在每请求一次的加载阶段，不会进入 open-sse 热路径。
- 标准模型绑定覆盖只作用于当前标准模型候选，不会写入或污染供应商模型的全局能力；本地自定义模型覆盖按请求加载，编辑或删除后下一次请求立即生效。

### 3.1.1 行为变更：运行时采纳内置目录

统一之后，运行时不再只依赖静态表，而是把**内置标准模型目录**（`src/lib/standardModels/catalog.js`）也纳入能力来源。因此：

- 被目录标注为支持视觉的标准模型，其图片会**真正转发到上游**，而不再被 `stripUnsupportedModalities` 静默替换成占位文本。
- 若目录标注有误（模型实际不支持视觉），客户端会收到上游返回的 4xx，而不是此前的静默丢图。**这是本次有意的取舍**：显式失败比静默降级更容易被发现和修正。
- 已确认的影响面（把内置目录与静态表逐项比对，目前仅一项分歧）：

  | 模型 | 能力 | 静态表 | 目录（现生效） |
  | --- | --- | --- | --- |
  | `deepseek-v4-flash` | `vision` | `false` | `true` |

  内置目录共 5 个标准模型（`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`、`deepseek-v4-flash`、`glm-5.3-flash`），其余 4 个的静态表与目录一致，行为不变。

### 3.2 供应商别名归一化

数据库中可能保存 UI 别名 `cmc`，而运行时模型前缀是 `commandcode`。能力覆盖索引在加载和查询时统一经过供应商解析，因此以下标识会命中同一条记录：

```text
cmc/deepseek/deepseek-v4.1-flash
commandcode/deepseek/deepseek-v4.1-flash
```

模型 ID 本身保持原样，不做可能破坏供应商路径的截断或重写。

### 3.3 安全合并

运行时不会把数据库里的任意 JSON 字段直接展开到能力对象。只接受能力解析器明确支持的字段：

- 布尔能力：`vision`、`pdf`、`audioInput`、`videoInput`、`imageOutput`、`audioOutput`、`search`、`tools`、`reasoning`、`thinkingCanDisable`、`thinkingEffortSupported`
- 思考协议：受控的 `thinkingFormat`
- 思考范围：`thinkingRange.min/max`
- 限制：`contextWindow`、`maxOutput`

未知字段、数组、非法数字和不支持的思考协议会被忽略；静态能力仍然保留。这避免了用户可编辑数据改变运行时内部状态或覆盖不相关配置。

### 3.4 CommandCode 多模态请求转换

- `prefetchRemoteImages()` 将 CommandCode 纳入需要 base64 的目标格式；远程图片继续经过 DNS/IP、重定向、大小和文件签名校验。
- `openai-to-commandcode.js` 将 data URI 解码为 CommandCode 的 `image/source` 结构。
- 同时兼容调用方直接传入的 Responses 风格 `input_image`；它会先归一化为相同的 `image/source` 结构，不再被序列化成普通文本。
- 对 DSH/原生适配器可能传入的 Claude 风格 `image.source` 也兼容：已有 `source.type=base64` 时直接保留，`source.type=url` 时先经过安全预取。
- CommandCode 远程图片预取也识别 `input_image`，并在开发日志中仅记录 `input images=N` 与上游 `images=N`，不输出图片内容。
- 如果受保护的远程图片预取失败，不发送未经确认支持的 URL 图片协议，而是发送明确的占位文本，避免上游收到错误格式。
- 图片块不再因为转换器的静态逻辑被无条件丢弃。

## 4. 修改文件与职责

| 文件 | 作用 |
| --- | --- |
| `open-sse/providers/capabilities.js` | 增加能力覆盖白名单校验和纯函数合并，不改变无覆盖时的旧行为 |
| `src/lib/modelCapabilities.js` | 从本地 DB 加载自定义模型能力，并创建请求级同步解析器；数据库异常时 fail-open 回退静态能力 |
| `src/sse/handlers/chat.js` | 每个聊天请求加载一次能力快照，并传给标准模型、combo、容量适配和单模型执行链 |
| `open-sse/handlers/chatCore.js` | 使用有效能力判断是否清洗视觉/音频/PDF，并传入翻译与思考转换 |
| `open-sse/services/combo.js` | combo 自动切换按有效能力排序，避免把已标记视觉模型错误降级 |
| `open-sse/services/capacityAdapter.js` | 容量适配器按有效能力判断是否需要追加视觉等能力模型 |
| `open-sse/translator/index.js`、`thinkingUnified.js`、`thinkingLevels.js`、`formats/claude.js` | 让思考协议、思考等级和输出上限读取同一份有效能力 |
| `open-sse/translator/concerns/prefetch.js` | 将 CommandCode 加入远程图片 base64 预取目标，并兼容 `input_image` |
| `open-sse/translator/request/openai-to-commandcode.js` | 将 OpenAI/Responses 图片块转换为 CommandCode 官方 CLI 图片块 |
| `open-sse/translator/formats/responsesApi.js`、`open-sse/translator/request/openai-responses.js` | 将 DSH 原生 `image/source`、数据型附件和 `messages[].images` 转换为 Responses `input_image`；同格式 Responses 路由也执行一次最终线规范化 |
| `open-sse/executors/commandcode.js` | 开发日志安全记录 CommandCode 实际发送的图片块数量 |
| `open-sse/executors/codex.js` | 兼容 `image`/`image_url`/`input_image` 的图片计数和远程图片预取 |
| `src/lib/standardModels/planner.js` | 将标准模型绑定的能力覆盖带入路由候选 |
| `src/app/api/v1/models/route.js` | `/v1/models` 对本地自定义/标准模型输出合并后的能力和输入模态；空能力的旧标准模型回退到权威目录 |
| `tests/unit/model-capability-overrides.test.js` | 覆盖视觉提升、非法字段过滤、combo 排序和容量适配回归 |
| `tests/unit/commandcode-multimodal.test.js` | 覆盖 CommandCode 图片 wire shape 和远程 URL 失败时的安全回退 |
| `tests/unit/codex-image-fetch.test.js` | 覆盖 Codex `input_image` 预取和图片日志计数相关路径 |
| `tests/unit/responses-prompt-cache-key-3216.test.js`、`tests/unit/modality-strip.test.js` | 覆盖 DSH 原生 base64/附件图片转换，以及入口图片计数 |

## 5. 兼容性与防回归设计

1. 静态 `getCapabilitiesForModel(provider, model)` 仍保持同步、纯函数和原有签名，所有未接入能力解析器的调用方行为不变。
2. 能力覆盖只存在于当前请求的 `Map` 和解析器，不修改静态表，不使用跨请求全局缓存。
3. 本地 DB 读取失败时继续使用原有静态能力，不让能力增强逻辑阻断聊天请求。
4. combo 和容量适配器的新增参数均为可选参数；旧调用方不传时继续走静态能力逻辑。
5. 标准模型候选的覆盖仅随候选传递，避免不同供应商之间互相污染。
6. 数据库中的本地测试数据没有迁移、重写或导出；本次改动只修改代码和测试/文档文件。

## 6. 验证记录

执行以下针对性测试（在仓库根目录运行；vitest 只安装在 `tests/node_modules`，
本机 `npx`/`npm exec` 的 shim 无法解析 `node`，因此直接调用本地二进制）：

```text
./tests/node_modules/.bin/vitest run --config tests/vitest.config.js \
  tests/unit/model-capability-overrides.test.js \
  tests/unit/capabilities.test.js \
  tests/unit/modality-strip.test.js \
  tests/unit/capabilities-service-kind.test.js
```

验收重点：

- 静态解析仍将 `commandcode/deepseek/deepseek-v4.1-flash` 判为非视觉模型，证明测试确实覆盖了原始缺陷。
- 合并本地 `{ vision: true, reasoning: true }` 后，视觉能力为真。
- combo 会将该自定义模型视为可处理视觉请求的候选。
- 已满足视觉能力时，容量适配器不会无意义地追加视觉回退模型。
- 没有覆盖时，原有模态清洗测试和静态能力测试保持通过。
- `image_url` 和 `input_image` 都会被识别为视觉输入；CommandCode 发出的请求应包含 `type=image` 的 base64 块。
- 旧数据库中能力为空的 `gpt-5.6-luna` 应从内置标准目录得到 `vision=true`；统一之后**运行时也走同一条目录层**，不再只是 `/v1/models` 展示层如此。`/v1/models` 应同时返回 `input_modalities: ["text", "image"]` 和 `inputModalities: ["text", "image"]`。
- 一致性地契约测试（`tests/unit/model-capability-consistency.test.js`）断言「运行时解析结果 == 发现层解析结果」，覆盖：`deepseek-v4-flash` 采纳目录（静态表为 `false`、目录为 `true`）、`gpt-5.6-luna` 空记录回退目录、部分对象 `{ tools: true }` 不遮蔽目录、显式 `{ vision: false }` 被尊重、service-kind 为 `imageToText` 的自定义模型两侧均为 `true`、显式 mapping override 优先级最高，以及全部 5 个内置标准模型两侧逐字段相等。

完整构建验证：

```text
npm run build
```

本次实际验证结果：

- 目标单元测试（能力层，6 个文件）：6 个测试文件、27 个测试全部通过。
  `model-capability-overrides` 5、`model-capability-consistency` 8、`capabilities` 8、
  `capabilities-service-kind` 2、`force-stream-config` 3、`minimax-transport-target-format` 1。

  ```text
  ./tests/node_modules/.bin/vitest run --config tests/vitest.config.js \
    tests/unit/model-capability-overrides.test.js \
    tests/unit/model-capability-consistency.test.js \
    tests/unit/capabilities.test.js \
    tests/unit/capabilities-service-kind.test.js \
    tests/unit/force-stream-config.test.js \
    tests/unit/minimax-transport-target-format.test.js
  ```

  说明：`force-stream-config` 与 `minimax-transport-target-format` 此前因本批改动把
  `chatCore.js` 的 import 扩成 `{countImageInputs, stripUnsupportedModalities, summarizeInputShapes}`
  而 mock 缺项变红，本次已补齐 mock。
- 全部相关单测合并执行（14 个文件）：**14 个测试文件、92 个测试全部通过**。
- 所有本次修改的 JavaScript 文件：`node --check` 全部通过。
- 本地开发服务聊天路由 smoke 请求：按当前本地设置返回预期的 `401 Missing API key`，说明新服务端模块已被路由加载且没有导入/编译错误；该请求没有访问任何上游供应商。
- `npm run build` 已启动，但在较长时间内一直停留在 `Creating an optimized production build ...`，进程持续占用约 3.1GB 内存且没有错误堆栈。为避免继续占用本机资源，本次手动终止该构建，不能将其记为“构建失败”；后续可在 CI 或资源更充足的环境重新执行完整构建。
- 本次链路修复后，重新执行图片/Responses/模态针对性回归：8 个测试文件、65 个测试全部通过。
  命令与逐文件用例数：

  ```text
  ./tests/node_modules/.bin/vitest run --config tests/vitest.config.js \
    tests/unit/commandcode-to-openai.test.js \
    tests/unit/commandcode-multimodal.test.js \
    tests/unit/commandcode-responses-pipeline.test.js \
    tests/unit/modality-strip.test.js \
    tests/unit/prefetch-images.test.js \
    tests/unit/codex-image-fetch.test.js \
    tests/unit/responses-prompt-cache-key-3216.test.js \
    tests/unit/image-fetch-hardening.test.js
  ```

  `commandcode-to-openai` 10、`commandcode-multimodal` 4、`commandcode-responses-pipeline` 2、
  `modality-strip` 16、`prefetch-images` 11、`codex-image-fetch` 5、
  `responses-prompt-cache-key-3216` 8、`image-fetch-hardening` 9。

- 回滚验证（证明新增测试具备判别力，验证后均已恢复）：
  1. 把 `resolveCapabilities` 的内置目录层置空（`const catalog = null`）→
     `model-capability-consistency` 中 2 个用例失败（`deepseek-v4-flash` 采纳目录、部分对象不遮蔽目录）。
  2. 把目录回退改回旧的**对象级**行为（persisted 非空则整体忽略目录）→
     「部分对象不遮蔽目录」用例失败。
  3. 上一轮同样对 prefetch 的 Responses 分支、`capResponsesBlock` 的剥离范围、
     CommandCode 的 `ensureState` 做过同类回滚，对应用例均会变红。
- 本地 `/v1/models` 实测 `gpt-5.6-luna` 返回视觉输入模态（`input_modalities` 含 `"image"`）。

如果构建失败，优先检查是否有模块导出/导入不匹配，尤其是 `open-sse/providers/capabilities.js` 的三个公开函数：
`normalizeCapabilityOverrides`、`mergeCapabilities`、`getCapabilitiesForModel`。

## 7. 后续排查手册

若未来仍出现“已勾选视觉但图片被移除”：

1. 在数据库确认 `custom_models` 对应记录的 `providerAlias`、`id`、`caps` 是否正确。
2. 确认请求使用的模型完整名与自定义记录一致，尤其检查 `cmc`/`commandcode` 别名和模型 ID 中的 `/`。
3. 查看请求日志中是否进入了标准模型候选、combo 或容量适配分支。
4. 检查 `chatCore` 是否收到 `modelCapabilities`，以及 `stripUnsupportedModalities` 使用的是否为该对象。
5. 若只有 `/v1/models` 展示不一致，先检查 API 路由是否对自定义模型执行了 `mergeCapabilities`；不要直接修改静态能力表来绕过数据库覆盖。
6. 若是视觉 benchmark，查看 CommandCode 请求前的开发日志：`[DBG:COMMANDCODE] execute start | images=1` 才能证明路由层生成了图片块；若 `images=1` 但 benchmark 仍报告 `vr-proof`，则图片已进入上游，剩余问题是上游模型识别结果或 benchmark 的证明格式，而不是 9router 丢图。

## 8. DSH Vision Router benchmark 兼容性

`dsh-vision-router` 的 `vr-proof` 是它自己的视觉证据校验：它会在临时 PNG 中叠加随机 `VR-CODE:<code>` 标记，并要求模型在文本末尾回传该标记；校验失败时，即使模型返回了非空文本，也会报告：

```text
benchmark response did not prove that the generated image was actually inspected
```

因此：

1. `responseEmpty=0` 只证明 DSH 收到了文本响应。
2. `prefixSeen=0`、`expectedCodeSeen=0`、`proofLikeLineSeen=0` 表示响应中完全没有视觉证明，不足以单独判断是响应 JSON 解析失败。
3. DSH 的 HTTP 兼容桥会把 Host 图片附件转换为 OpenAI `image_url` data URI；9router 再将其转换为 CommandCode 的 base64 `image/source` 块，或转换为 Codex Responses 的 `input_image`。当前支持 `image_url`、`input_image`、已物化的 `image.source`，以及数据型消息附件/`messages[].images`。同格式 Responses 请求也会在最终发送前完成 `image → input_image` 规范化。
4. `/v1/models` 对具备视觉能力的模型额外输出 `input_modalities`、`inputModalities`、`input` 和 `modalities.input`，覆盖 DSH/llm-pi-ai 与 OpenAI 兼容客户端常见的能力字段；这些字段只是能力描述，不改变模型 ID、路由顺序或供应商请求格式。
5. 诊断时先对照两条日志：`input images=N` 是入口请求收到的图片块数，Codex/CommandCode 的 `execute start | images=N` 是格式转换后准备发往上游的图片块数。入口为 0 说明 DSH/适配器没有把图片序列化进 HTTP 请求；入口大于 0 但上游为 0，说明在能力清洗或格式转换阶段丢失。两个位置都为 1 且请求体明显变大，说明图片已发往供应商，后续应检查模型是否能读出小尺寸随机标记，或 DSH benchmark 输出协议是否被模型忽略。
6. 当上游图片数大于 0 时，CommandCode 还会记录 `visual proof token=seen|not-seen`。该字段只表示响应文本是否出现 `VR-CODE:` 或 `_vr_code` 证明字段，不记录随机验证码；`not-seen` 表示问题已经进入模型输出/上游行为阶段，`seen` 但 DSH 仍失败则应继续检查 DSH 的流式消费或后续清洗。

注意：DSH 的原生适配器路径可能只把 `{ type: "image", attachment: { attachmentId } }` 发送给 9router。`attachmentId` 属于 DSH 进程自己的附件存储，9router（尤其是独立 Docker 容器）不能凭 ID 读取图片；只有 DSH/Host 在 HTTP 边界物化为 `image_url` data URI、`source.type=base64` 或可访问 URL 后，9router 才能继续转发像素。此时应看到入口 `shape=...image...` 且图片数大于 0；若只看到裸引用，应修正 DSH 适配器的物化方式，不能通过修改模型能力字段解决。

该错误的来源与规则可在 [`dsh-vision-router` 的视觉证明校验代码](https://github.com/ysr666/dsh-vision-router/blob/main/lib/vision-capability-benchmark-hardening.js)、[benchmark 调用链](https://github.com/ysr666/dsh-vision-router/blob/main/lib/vision-capability-benchmark-service.js) 和 [OpenAI 图片桥接代码](https://github.com/ysr666/dsh-vision-router/blob/main/lib/core-primitives.js) 中核对。
