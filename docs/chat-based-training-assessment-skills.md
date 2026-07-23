# 自动出题培训系统 — 通过聊天完成培训并量化考核的方法和 Skill 调研

> 调研日期: 2026-03-31  
> 来源: ClawHub (clawhub.ai) OpenClaw Skill 生态 + 外部资料  
> 重点: 能自动出题、先培训再量化考核的完整闭环系统

---

## 背景

目标：找到能通过 AI 聊天对话**自动出题**、**先进行培训**、然后对培训结果给出**显式、可量化**评估参数的 Skill 或流程。

---

## 第一类：完整闭环 — 培训 + 自动出题 + 量化考核

### ★★★ Skill: `exam` — 考试准备全流程系统

**链接**: [clawhub.ai/ivangdavila/exam](https://clawhub.ai/ivangdavila/exam)

**核心能力**:
- 从任意学习材料**自动生成题目**（选择题、填空题、简答题、论述题）
- 模拟真实考试环境（计时、题量、及格线）
- 逐题评分 + 自适应练习 + 薄弱点分析
- 持久化成绩追踪和进步趋势

**工作流程**:
```
提供学习材料 → 自动生成题目 → 练习/模拟考试 → 评分 → 薄弱点分析 → 针对性强化
```

**自动出题机制**:

| 难度 | 题目类型 |
|---|---|
| Easy | 记忆、定义、基本概念 |
| Medium | 应用、比较、分析 |
| Hard | 综合、边界情况、多步推理 |

**出题方式**:
- `"从这份 AWS S3 笔记生成 10 道题"` — 从材料自动出混合题型
- `"5 道关于数据库规范化的难题"` — 按主题和难度出题
- `"模拟 PMP 考试风格出题"` — 匹配真实考试格式

**量化评估体系**:

| 维度 | 量化方式 |
|---|---|
| 每题得分 | ✅/❌ + 用时 |
| 按主题正确率 | 百分比 (如 VPC: 71%, Lambda: 52%) |
| 整体正确率 | 百分比 + 趋势 |
| 模拟考试分数 | X/总分 (如 52/65 = 80%) |
| 通过判定 | PASS/FAIL (对照及格线, 如 72%) |
| 薄弱领域 | 自动按正确率排序标记 |

**自适应出题策略**:
```
40% 薄弱主题题目
30% 中等主题题目
20% 强项主题题目 (维持)
10% 新主题题目
```

**成绩追踪输出示例**:
```
📋 考试就绪报告: AWS SAA

整体: 76% 就绪

按领域:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
弹性架构设计    ████████░░ 82%
高性能架构      ███████░░░ 71%
安全架构设计    ████████░░ 78%
成本优化        ██████░░░░ 64% ⚠️

优先强化:
1. DynamoDB (48%) — 建议再做 15 题
2. 成本优化 (64%) — 建议再做 10 题
3. Lambda (52%) — 建议再做 12 题

预估所需学习时间: 4-6 小时
```

**数据持久化**: `~/exams/{subject}/` 下保存题库、练习历史、各主题成绩、闪卡

---

### ★★★ Skill: `learn` — 间隔重复 + 主动回忆学习系统

**链接**: [clawhub.ai/ivangdavila/learn](https://clawhub.ai/ivangdavila/learn)

**核心能力**:
- 将任何学科分解为概念，逐个教学
- 自动生成主动回忆题目（不是被动复习）
- 间隔重复算法自动调整复习时间
- 掌握度验证: 5 题答对 4/5 才算掌握

**工作流程**:
```
确定学习目标 → 分解概念 → 学习 → 主动回忆出题 → 自评 → 间隔重复 → 掌握验证
```

**量化评估体系**:

| 维度 | 量化方式 |
|---|---|
| 掌握度 | 5 级: 识别 → 回忆 → 应用 → 迁移 → 能教会别人 |
| 间隔重复分数 | ease_factor (初始 2.5, 动态调整) |
| 验证通过 | 5 题答对 ≥4 才算掌握 |
| 置信校准 | 预测正确率 vs 实际正确率 (检测虚假自信) |
| 概念进度 | 每个概念的 interval_days 和 next_review |

**掌握验证方法**:
- 自由回答 > 选择题 (生成优先于选择)
- 教回法: 让学习者向 AI 解释概念
- 新题验证: 不是练习集中的原题
- 时间压力: 去除查阅依赖
- 间隔验证: 过若干天后复测

**数据持久化**: `~/learn/topics/{topic}/` 保存概念、笔记、进度

---

### ★★☆ Skill: `study-tutor` — 科学学习辅导系统

**链接**: [clawhub.ai/jiangkaiqi2005/study-tutor](https://clawhub.ai/jiangkaiqi2005/study-tutor)

**核心能力**:
- 完整学习流程: 课前诊断 → 备课 → 预习 → 笔记 → 复习 → 间隔重复 → 周测 → 备考
- 基于认知科学 (Active Recall, Spaced Repetition, Testing Effect)
- 针对不同人群 (中小学生/大学生/自学者/备考者) 自动调整教学策略
- 自动出题: 课后三题法 + 主动回忆测试 + 模拟考

**工作流程**:
```
课前诊断 (目标+基线) → 教练备课 → 引导学习 → 课后出题复习 → 间隔复习出题 → 周测评估 → 备考模拟
```

**量化评估**: 课前基线 vs 课后测验对比, 每次复习的正确率追踪, 错题归因分析

---

### ★★☆ Skill: `tutor` — 个性化辅导系统

**链接**: [clawhub.ai/ivangdavila/tutor](https://clawhub.ai/ivangdavila/tutor)

**核心能力**:
- 先评估再教学, 苏格拉底引导式
- 为每个学习者建立独立档案 (年龄/学习风格/目标)
- 会话日志 + 概念掌握追踪 + 薄弱点分析
- 定期生成进度报告

**数据持久化**: `~/tutor/{learner}/` 保存 profile, sessions, progress, reports

---

## 第二类：纯考核系统 — 自动出题 + 量化评分 (不含培训环节)

### ★★★ Skill: `interview-simulator` — 模拟面试评估系统

**链接**: [clawhub.ai/wscats/interview-simulator](https://clawhub.ai/wscats/interview-simulator)

**核心能力**:
- 支持任意角色任意职级的模拟面试
- 自动按岗位和级别生成对应难度的题目
- 逐题 1-10 分评分 + 即时反馈
- 最终输出带 Verdict 的完整记分卡

**量化评估体系**:

| 维度 | 量化方式 |
|---|---|
| 每道题 | 1-10 分 + ✅ 做得好 / ⚠️ 待改进 / 💡 理想答案 |
| 模块评分 | 系统设计 X/10、编码 X/10、行为面试 X/10 等 |
| 总分 | 加权平均 X/10 |
| 最终判定 | Strong Hire / Hire / Lean Hire / Lean No Hire / No Hire |

**评分标准 (Rubric)**:

| 分数 | 等级 | 含义 |
|---|---|---|
| 9-10 | Exceptional | 超出该等级预期，可胜任更高职级 |
| 7-8 | Strong | 小缺陷，整体扎实，满足预期 |
| 5-6 | Adequate | 可接受但有明显差距，需改进 |
| 3-4 | Below Expectations | 缺少基本概念或技能 |
| 1-2 | Insufficient | 无法有效回答 |

---

### ★★☆ Skill: `quiz` — 多类型测验设计系统

**链接**: [clawhub.ai/ivangdavila/quiz](https://clawhub.ai/ivangdavila/quiz)

**核心能力**:
- 设计知识测验、性格测验、评估测验、趣味问答
- 多种评分模式: 简单百分比、加权评分、多维度诊断评分
- 即时反馈 + 连续答对奖励 + 排行榜

**评分模式**:

| 模式 | 适用场景 |
|---|---|
| 简单百分比 | 正确数/总题数 × 100, 知识测验 |
| 加权评分 | 不同题目不同权重, 能力优先级评估 |
| 分支结果 | 答案组合映射到不同结果, 性格测验 |
| 诊断量表 | 多维度打分, 技能评估 |

---

## 第三类：培训设计框架 — 生成课程大纲 + 评估模板 (需人工执行)

### ★★☆ Skill: `training-course-designer` — 企业培训课程设计器

**链接**: [clawhub.ai/brandon-zhanghaodong/training-course-designer](https://clawhub.ai/brandon-zhanghaodong/training-course-designer)

**核心能力**:
- 一键生成完整培训包 (课程材料 + 讲师指南 + 学员手册 + 评估模板 + 营销文案)
- 内置 **Kirkpatrick 四级评估模型** 模板:
  - Level 1: 反应评估 (满意度调查)
  - Level 2: 学习评估 (培训前知识测试 + 培训后测验, ≥70% 通过)
  - Level 3: 行为评估 (30 天后应用调查)
  - Level 4: 结果评估 (业务影响)
- 自动生成前测/后测对比题目

**培训前测试 → 培训后对比**:
```
培训前: 10-15 道基线测试题 (选择题+判断题+简答题)
培训后: 20-25 道考核测试题 (40% 选择 + 20% 判断 + 20% 场景 + 20% 简答)
通过标准: ≥70%
对比指标: 前测 vs 后测分数提升
```

---

### ★★ Skill: `afrexai-training-program` — 员工培训课程构建器

**链接**: [clawhub.ai/1kalin/afrexai-training-program](https://clawhub.ai/1kalin/afrexai-training-program)

**核心能力**: 模块化课程设计 + 每模块 Quiz (≥70%) + 1-5 能力评分 + 完成度追踪 + ROI 指标

---

### ★★ Skill: `afrexai-executive-coaching` — 高管教练系统

**链接**: [clawhub.ai/1kalin/afrexai-executive-coaching](https://clawhub.ai/1kalin/afrexai-executive-coaching)

**核心能力**: 领导力健康检查 /16 分 + 360° 反馈 (1-5×6 域) + GROW 模型 + 30/60/90 天进度追踪

---

### ★★ Skill: `afrexai-performance-review` — 绩效评审引擎

**链接**: [clawhub.ai/1kalin/afrexai-performance-review](https://clawhub.ai/1kalin/afrexai-performance-review)

**核心能力**: 1-5 加权评分 (5 维度) + STAR-I 方法 + 团队校准 + 评分分布指引

---

## 第四类：特定领域考试系统

| Skill | 描述 | 出题能力 | 评估方式 |
|---|---|---|---|
| [`exam-generator`](https://clawhub.ai/tobewin/exam-generator) | 中国中小学试卷生成器 | 按课标自动出卷 | 按标准答案评分 |
| [`gaokao`](https://clawhub.ai/ivangdavila/gaokao) | 高考备考系统 | 按学科+考点出题 | 薄弱点分析 + 间隔重复 |
| [`ket`](https://clawhub.ai/zhqinqin123run-lgtm/ket) | 剑桥 KET 英语考试备考 | 听说读写分项出题 | 分项评估 |
| [`developer-interview-simulator`](https://clawhub.ai/phantue2002/developer-interview-simulator) | 开发者面试模拟 | 按技术栈出题 | 1-10 分 + 记分卡 |
| [`backend-interview-simulator`](https://clawhub.ai/phantue2002/backend-interview-simulator) | 后端面试模拟 | 系统设计/API/并发出题 | 1-10 分 + 记分卡 |

---

## 总结: 按"培训 + 自动出题 + 量化考核"完整度排序

| 排名 | Skill | 自动出题 | 培训教学 | 量化考核 | 进度追踪 | 完整度 |
|---|---|---|---|---|---|---|
| 🥇 | **`exam`** | ✅ 从任意材料自动生成多题型 | ✅ 薄弱点针对性强化 | ✅ 百分比+趋势+就绪报告 | ✅ 持久化 | ★★★★★ |
| 🥈 | **`learn`** | ✅ 主动回忆自动出题 | ✅ 间隔重复教学 | ✅ 掌握验证 (4/5) + 置信校准 | ✅ 持久化 | ★★★★☆ |
| 🥉 | **`study-tutor`** | ✅ 课后/周测自动出题 | ✅ 全流程教学 | ✅ 前后对比 + 错题归因 | ✅ 持久化 | ★★★★☆ |
| 4 | **`tutor`** | ✅ 理解检查出题 | ✅ 苏格拉底引导 | ✅ 概念掌握追踪 | ✅ 持久化 | ★★★☆☆ |
| 5 | **`interview-simulator`** | ✅ 按岗位/级别出题 | ❌ 纯考核 | ✅ 1-10分 + 记分卡 | ❌ 无 | ★★★☆☆ |
| 6 | **`training-course-designer`** | ✅ 生成前测/后测题 | ✅ 课程材料设计 | ✅ Kirkpatrick四级 | ❌ 需人工 | ★★★☆☆ |
| 7 | **`quiz`** | ✅ 多类型题目设计 | ❌ 纯测验 | ✅ 多种评分模式 | ❌ 无 | ★★☆☆☆ |

---

## 推荐组合方案

### 方案 A: 最佳完整闭环 (推荐)

```
exam + learn 组合使用

流程:
1. 用 learn 建立学习计划, 分解概念, 间隔重复教学
2. 用 exam 从学习材料自动出题, 模拟真实考试
3. exam 的薄弱点分析 → 反馈给 learn 针对性强化
4. 循环直到 exam 就绪报告显示通过
```

### 方案 B: 企业培训场景

```
training-course-designer + exam 组合使用

流程:
1. training-course-designer 生成完整课程大纲 + 前测题
2. 先做前测, 记录基线分数
3. 按课程模块进行培训
4. 用 exam 按模块自动出后测题
5. 对比前测 vs 后测分数, 量化培训效果
```

### 方案 C: 对话式教练 + 考核

```
tutor + interview-simulator 组合使用

流程:
1. tutor 建立学习者档案, 诊断基线水平
2. tutor 引导式教学, 逐步建立知识体系
3. interview-simulator 进行正式考核, 输出量化记分卡
4. 对比学习前后的记分卡变化
```
