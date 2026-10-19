# 语义核对案例

| 原文 | 可接受译文 | 需拦截的变化 |
| --- | --- | --- |
| The proposed controller may reduce torque ripple under the tested conditions. | 所提出的控制器在所测试的条件下可能减小转矩脉动。 | “消除了转矩脉动”：丢失可能性、适用条件并夸大效果。 |
| No statistically significant difference was observed (p = 0.08, n = 42). | 未观察到统计学显著差异（p = 0.08，n = 42）。 | “两组完全相同”：未显著不代表等效。 |
| The error decreased by 5%, not by 5 percentage points. | 误差降低了 5%，而不是降低了 5 个百分点。 | 混用相对变化与百分点。 |
| Assuming constant rotor resistance, the estimate remains bounded. | 假设转子电阻恒定，估计值保持有界。 | 漏译假设，或将“有界”译为“收敛”。 |
| References: 1. Smith ... [CrossRef] / 2. Jones ... [CrossRef] | 两个独立的编号段落，文章题名可译，作者及刊名保持原文。 | `[CrossRef]2.` 粘连、重新编号、补造 DOI。 |
| The treatment group had 10 events and control had 20 events. | 治疗组有 10 起事件，对照组有 20 起事件。 | 两组数值互换后数字集合仍相同，必须单独核对组别绑定。 |
| The system is stable only if the gain is positive. | 系统稳定的必要条件是增益为正。 | “只要增益为正就稳定”颠倒必要与充分条件。 |
| Here CI means computational intelligence, not confidence interval. | 此处 CI 指计算智能，而非置信区间。 | 沿用其他章节的 CI 译法，忽略本地定义。 |
| ABC is used here; XYZ is defined as the sample size. | 此处使用 ABC；XYZ 定义为样本量。 | 不能把 XYZ 的定义证据挂到 ABC 或子串 BC。 |

文本对照示例：

**原文**：The results suggest improved tracking, but do not establish robustness to sensor faults.

**译文**：结果表明跟踪性能可能有所改善，但尚不能据此确认其对传感器故障的鲁棒性。

核对记录应列具体位置和依据，如“第 4 页，式 (8) 后第一段：原文 bounded 应译为有界，而非收敛”。不要仅给抽象质量分。

程序结构检查通过仅表示实际检查的结构和标识一致。语义条目模型复核通过、未抽中、复核失败和人工通过须分别记录；无真实位置时写未定位。修改了一个词的译文也是新版本，不能沿用旧版本人工通过状态。
