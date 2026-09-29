# CTX 第一版

保留 model/thinking、pi usage/contextWindow 与进度条。context-mode 的 Events captured 和 Compactions 显示在进度条下方，Composition 内容直接展示，以横线与估算统计分隔，不再显示折叠标题或注册点击监听。内容超出分配高度可滚轮滚动，CTX 最大高度为终端的 35%（至少 10 行），沿用 sidebar 的滚动布局，不获取编辑器键盘焦点。

## 估算口径

- approx = 本地可观测文本 UTF-16 长度 / 4，逐消息向上取整；不是模型 tokenizer。已知消息先经公开 SDK `convertToLlm` 转换，再提取文本，因此包含摘要包装、bash 无输出/退出/取消/截断提示；仍按原始角色分类。未知角色安全降级为外层 content 文本，`excludeFromContext` 的 bash 不计入。
- 六类为 System、Tools、Messages、Tool Results、Summary、Other。百分比分母是已覆盖分类的估算 token 合计，不是模型窗口；pi usage 单独展示，不校准分类。
- System 使用 ctx.getSystemPrompt() 的可观测字符串；无法取得时 unknown。Tools 通过 pi.getActiveTools()/getAllTools() 仅选取当前启用的工具，逐工具序列化 `{name, description, parameters}`，按 UTF-16 长度 / 4 向上取整后合计，并纳入分类百分比分母。不计 sourceInfo、执行函数及已归入 System 的 promptGuidelines；Fabric 捕获但未直接启用的工具不重复计入。无启用工具为 0；API 不可用、启用工具缺少定义或 schema 无法序列化时保持 unknown，避免显示不完整合计。工具定义在每次现有快照事件刷新时重新读取（包括动态启用/禁用），不在 render 中读取；空闲时注册工具将在下一次快照事件反映。
- Tools 在 `before_provider_request` 事件后优先统计 provider-specific payload 的 `tools` 字段序列化文本（仍按 UTF-16 长度 / 4 估算）；请求发出前未观察到 payload 时，回退到当前启用工具 schema 的本地估算。它仍不是模型 tokenizer、HTTP 字节数或计费 token，也不包含 headers；如果后续扩展继续改写 payload，面板值可能是本扩展处理时观察到的版本。Images 仅统计图片块数量，不序列化请求或计算未展示的字节数；在 `before_provider_request` 可取得最终 provider payload 时优先统计该 payload，否则统计当前 context 消息；未能观测时显示 `not observed`。
- context 事件提供调用前的消息快照；session_start/tree/compact、turn_end、agent_settled 使用 buildContextEntries() 重建 compaction-applied active branch。后者显示 active branch，前者显示 context hook。事件之外只读取缓存，不在 render 中扫描历史。
- Messages 包括 user/assistant 文本、thinking 和 tool call 名称/参数；Tool Results 仅计 content；Summary 包括 compaction/branch summary；Other 包括可发送 custom message 和非排除的用户 bash。
- Tool Results 按当前快照工具结果文本估算。Fabric 外层 content 只计一次，不遍历内部操作；不读 details、全量 JSONL、沙箱、截断前原始输出或被压缩结果。已返回 content 内的截断提示本身仍属于可发送文本。

Composition 的 token 估算使用 `~` 前缀及 K/M 紧凑缩写（四舍五入），百分比保留一位小数。宽度不足时标签与数值拆行；支持的最小侧栏宽 18 可完整显示如 `~100K 100.0%`。

## 本次提问增量

以一次提问（`before_agent_start` 到 `agent_settled`）为单位：基线是上一次提问结束后的分类估算总量，`turn_end` 只重算快照、不推进基线，因此增量在提问进行中实时增长，`agent_settled` 后定格。数值是净增长，压缩造成的下降显示为负。`session_start`、`session_tree`、`session_compact` 会把基线重置为当前总量，此时不显示增量。

进度条最右侧的 accent 段是增量在窗口中的份额，宽度为 `round(内容宽 × 增量 / contextWindow)`，向上至少 1 格，且不会超出已用段，所以条的总长度不变。增量文字显示在 `已用%/窗口` 之后：正增量用 accent，负增量用 warning。增量为 0、基准未建立或窗口未知时，既不留文字也不画段。增量与分类估算同源（本地启发式），不含 `~` 前缀。

## 活动指标（原 ACTIVITY 面板）

独立 ACTIVITY 面板已移除，其内容移到进度条下方，以横线与分类统计分隔：状态 + 平均性能、最新 TTFT。

- 第一行：`N turns · 时长 · AVG TTFT · AVG TPS`。运行中时长按秒刷新（CTX 面板每秒 requestRender 一次），settled 后显示 `done 时长`，空闲显示 `Ready`。窄屏依次回退为 `状态`、`NT done 时长`、仅平均值，保证窗口内可见。
- 第二行：最新一次观测到的 TTFT（含 fast/normal/slow 标签），不是平均值——平均值只在第一行。进行中且尚无 TTFT 时显示 `pending`。
- 追踪器（TTFT/TPS 采样、turn 与工具记录）位于 `ctx/activity.ts`，由 `ctx/panel.ts` 渲染时读取；活动快照只用于这两行，面板不再注册独立的 layout 条目。

## 限制

这是明确标记的本地估算，不宣称最终请求精确统计。后加载扩展仍可能改写 context 或 provider payload；不同 provider 的转换、剔除、包装开销未知。恢复/回合结束时 active branch 可能不同于上次请求经过 context 扩展裁剪后的快照；下一次 context 事件会替换它。模型生成过程中不逐 token 更新分类，最终回合/settled 时更新。只含图片的消息可见文本为零，不代表图片成本为零。

未修改 pi core、Fabric 或全局配置。全屏鼠标/极短终端还应在用户真实终端手工确认。
