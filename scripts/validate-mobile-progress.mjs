import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = 'docs/handoff/mobile-frontend-batch-20261113';
const tablePath = 'docs/handoff/Android-iOS-对照适配验收表-20261113.md';
const matrix = JSON.parse(fs.readFileSync(path.join(directory, 'item-matrix.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(directory, 'source-inventory.json'), 'utf8'));
const baseline = JSON.parse(execFileSync('git', [
  'show', `${matrix.pcWebBaseline.commit}:${matrix.pcWebBaseline.path}`,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const present = value => typeof value === 'string' && value.trim().length > 0;
const date = value => present(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const ids = new Set(matrix.items.map(row => row.id));
check(ids.size === matrix.items.length, '条目编号重复');
for (const original of baseline.items) {
  const row = matrix.items.find(item => item.id === original.id);
  check(row?.feature === original.feature, `${original.id} 缺失或与PC/Web基线功能名不同`);
  check(row?.pcWebBaseline?.fullAcceptance === original.fullAcceptance, `${original.id} PC/Web快照状态不一致`);
}
check(matrix.items.filter(row => row.id.startsWith('F')).length === baseline.items.length, 'PC/Web映射项数不一致');
const mobile = matrix.items.filter(row => row.id.startsWith('M'));
check(mobile.length === inventory.officialMobileEntries.length, '移动专属项与官方清单数量不同');
for (const [index, row] of mobile.entries()) {
  check(row.id === `M${String(index + 1).padStart(3, '0')}`, '移动专属编号不连续');
  check(row.feature === inventory.officialMobileEntries[index].name, `${row.id} 与官方清单名称不同`);
  check(row.officialReference.sourceEvidence.length > 0, `${row.id} 缺少官方源码定位`);
}
for (const row of matrix.items) {
  check(present(row.acceptanceCriteria) && present(row.mapping), `${row.id} 缺少验收条件或范围`);
  check(row.pcWebRefs.every(id => baseline.items.some(item => item.id === id)), `${row.id} 关联了未知PC/Web编号`);
  for (const platform of ['android', 'ios']) {
    const state = row[platform];
    check(state && present(state.implementationStatus), `${row.id}/${platform} 缺少实现状态`);
    check(['未验收', '验收中', '已通过', '不适用'].includes(state?.acceptanceStatus), `${row.id}/${platform} 验收状态无效`);
    const terminal = state?.acceptanceStatus === '已通过' || state?.acceptanceStatus === '不适用';
    check(state?.fullAcceptance === terminal, `${row.id}/${platform} 状态与关闭标记不符`);
    if (terminal) {
      check(date(state.completedAt) && present(state.owner) && state.evidence.length > 0, `${row.id}/${platform} 关闭缺少完成时间、负责人或证据`);
      if (state.acceptanceStatus === '已通过') {
        check(present(state.candidate?.commit) && present(state.candidate?.package) && present(state.candidate?.os), `${row.id}/${platform} 缺少候选提交、安装包或系统版本`);
      } else check(present(state.scopeDecision), `${row.id}/${platform} 不适用缺少范围依据`);
    } else check(state.completedAt === null, `${row.id}/${platform} 未完成项填写了完成时间`);
  }
  check(row.fullAcceptance === (row.android.fullAcceptance && row.ios.fullAcceptance), `${row.id} 双端关闭状态不一致`);
  check(row.wholeItemStatus === (row.fullAcceptance ? '已关闭' : '未关闭'), `${row.id} 整项状态不一致`);
  check(row.fullAcceptance ? date(row.completedAt) : row.completedAt === null, `${row.id} 整项完成时间不一致`);
}
const executionPlan = matrix.executionPlan
  ? JSON.parse(fs.readFileSync(matrix.executionPlan, 'utf8'))
  : null;
if (executionPlan) {
  const batches = new Map(executionPlan.batches.map(batch => [batch.id, batch]));
  const assignments = new Map();
  check(batches.size === executionPlan.batches.length, '执行批次编号重复');
  for (const batch of executionPlan.batches) {
    for (const id of batch.items) {
      check(ids.has(id), `${batch.id} 包含未知条目 ${id}`);
      check(!assignments.has(id), `${id} 重复归入执行批次`);
      assignments.set(id, batch.id);
    }
    for (const dependency of batch.dependencies) {
      check(batches.has(dependency) && dependency < batch.id, `${batch.id} 前置批次无效：${dependency}`);
    }
    for (const id of batch.reuseCompleted) {
      check(matrix.items.some(row => row.id === id && row.fullAcceptance), `${batch.id} 引用的已关闭证据 ${id} 未关闭`);
    }
  }
  const closedAtPlanning = new Set(executionPlan.closedAtPlanning);
  check(closedAtPlanning.size === executionPlan.closedAtPlanning.length, '规划时已关闭条目重复');
  check(executionPlan.totalItems === matrix.items.length, '规划条目总数不一致');
  check(executionPlan.plannedItems === assignments.size, '规划剩余项数不一致');
  for (const id of closedAtPlanning) {
    check(ids.has(id) && !assignments.has(id), `${id} 规划时关闭记录与批次重叠或未知`);
  }
  for (const row of matrix.items) {
    check(row.fullAcceptance || assignments.has(row.id), `${row.id} 未关闭且没有执行批次`);
    check(assignments.has(row.id) || closedAtPlanning.has(row.id), `${row.id} 遗漏于规划`);
    check(row.executionBatch === assignments.get(row.id), `${row.id} 表格批次与计划不一致`);
  }
}
const counts = {
  pcWebMappedItems: baseline.items.length,
  mobileSpecificItems: mobile.length,
  totalItems: matrix.items.length,
  androidClosed: matrix.items.filter(row => row.android.fullAcceptance).length,
  iosClosed: matrix.items.filter(row => row.ios.fullAcceptance).length,
  wholeItemsClosed: matrix.items.filter(row => row.fullAcceptance).length,
  scopePendingItems: matrix.items.filter(row => row.mapping.includes('待核定')).length,
};
for (const [key, value] of Object.entries(counts)) check(matrix.progressAccounting[key] === value, `${key} 汇总不一致`);
for (const platform of ['android', 'ios']) {
  for (const key of ['components', 'apiCalls']) {
    const rows = inventory[platform][key];
    check(new Set(rows.map(row => row.id)).size === rows.length, `${platform}/${key} 子清单编号重复`);
    check(rows.every(row => row.ownerItem === (key === 'components' ? 'F156' : 'F157')), `${platform}/${key} 缺少覆盖归属`);
    const owner = matrix.items.find(row => row.id === (key === 'components' ? 'F156' : 'F157'));
    if (owner[platform].fullAcceptance) {
      for (const child of rows) {
        const status = child.acceptanceStatus ?? child.status;
        check(['已通过', '不适用'].includes(status) && date(child.completedAt) && child.evidence.length > 0, `${child.id} 子项证据尚未闭合`);
      }
    }
  }
}
const escape = value => String(value ?? '—').replaceAll('|', '／').replaceAll('\n', ' ');
const label = value => value ?? '—';
const state = value => `${value.implementationStatus}。${value.sourceObservation}`;
const stamp = row => `Android ${label(row.android.completedAt)}；iOS ${label(row.ios.completedAt)}`;
const lines = [
  '# Android / iOS 对照适配与验收表', '',
  `更新于 ${matrix.updatedAt}。共 ${counts.totalItems} 项，含 PC/Web 原编号 ${counts.pcWebMappedItems} 项和移动专属 ${counts.mobileSpecificItems} 项。Android 与 iOS 分别记录实现、验收、候选包、负责人和完成时间。`, '',
  `PC/Web 对照快照为 \`${matrix.pcWebBaseline.commit}\`，当时关闭 ${matrix.pcWebBaseline.closed} / ${matrix.pcWebBaseline.items} 项。移动端当前新版基线整项关闭 ${counts.wholeItemsClosed} / ${counts.totalItems} 项。历史实现与验证记录见子清单。`, '',
  '## 参考版本与当前实现', '',
  '| 对象 | 参考或源码基线 | 状态 |', '| --- | --- | --- |',
  `| 官方参考 | Android Claude ${matrix.officialReference.version}，versionCode ${matrix.officialReference.versionCode} | Google Play手机导出，REA、JADX和Apktool静态解析 |`,
  `| Android客户端 | \`${matrix.clientBaselines.android.branch}\` / \`${matrix.clientBaselines.android.commit}\`，${matrix.clientBaselines.android.version} (${matrix.clientBaselines.android.build}) | 工作区含 ${matrix.clientBaselines.android.workingTree.length} 个未提交路径，本次观察包含这些改动 |`,
  `| iOS客户端 | \`${matrix.clientBaselines.ios.branch}\` / \`${matrix.clientBaselines.ios.commit}\`，${matrix.clientBaselines.ios.version} (${matrix.clientBaselines.ios.build}) | 工作区含 ${matrix.clientBaselines.ios.workingTree.length} 个未提交路径，本次观察包含这些改动 |`, '',
  'iOS按用户指定参考上述Android版本的界面、布局、文案和功能。系统相机、文件选择、权限、返回手势、分享与后台策略在各自平台验证。Android特有系统角色应记录iOS等效入口或有依据的平台差异。', '',
  'Android 已重编原版 1.261111.19 的六个 DEX 和资源表，并在原版界面验证文本首发、追问与重开。[整包重建记录](../../docs/acceptance/Mobile-Android-Official-Frontend-2026-11-13.md) 记录实验包覆盖范围。F001 表内的完成时间对应既有 Android 和 iOS 候选包。其字体和提示文案可通过 [导入脚本](../../scripts/import-official-mobile-composer.py) 重现。', '',
  'Claudex采用余额制。Usage、Billing及充值按本站合同验收，F061和M020记录与官方订阅的产品差异，检查所有Upgrade入口及相关文案。', '',
  '## 整项关闭规则', '',
  '每项执行顺序为官方源码和运行配置定位、两端实现对照、候选构建安装、正常入口操作、真实服务及适用异常分支、重开回读、记录证据。纯界面项按其交互范围验收，涉及模型、文件、付款或工具副作用的条目核对对应实际结果。', '',
  '- 逐项记录加载、空态、失败、取消、重试、快速重复操作、切账号和重启的适用结果。无该分支时附源码或系统范围依据。',
  '- 移动公共条件包括软键盘与中文输入法、系统返回、权限允许/拒绝/撤销、前后台与进程回收、锁屏、网络切换、深浅主题、字体放大、窄屏和支持的横屏/平板布局、TalkBack/VoiceOver。每个条件绑定适用功能。',
  '- 验收状态使用“未验收”“验收中”“已通过”“不适用”。源码观察独立保留；本轮已通过必须有候选源码提交、包/构建号、OS和设备、步骤、预期/实际结果及证据位置。',
  '- Android和iOS分别完成所有适用分支后关闭整项。平台“不适用”需要明确来源和范围判定，不能由未找到代码推断。',
  '- 平台完成时立即写入各自的completedAt，整项关闭时再写整项时间，均保留时区。未完成时间留空。', '',
  '## 协作与进度', '',
  '本表在共享分支 `codex/pc-web-adaptation-integration` 维护。实施前认领平台与编号，推送成功后开工；关闭时同次提交源码、证据、完成时间和表格。每位负责人现有五项共享待办按PC/Web共用队列执行，移动端按本表登记负责人。跨平台共用代码需登记唯一负责人。', '',
  '优先级P0覆盖首发/追问、模型、附件、停止、草稿、黑白闪屏与动画跳动、断线恢复和账号隔离。F023等范围缺口及移动系统差异保留待核定，范围判定与功能通过分别记录。', '',
  ...(executionPlan ? ['[移动端批次计划](移动端适配与验收批次计划-20261115.md)：相近功能共用候选包、账号、数据与端到端链路；按原编号逐项关闭。批次归组不改变负责人、验收状态和完成时间。', ''] : []),
  '## 逐项对照', '',
  '| 编号 | 批次 | 功能与优先级 | PC/Web对照 | Android当前实现 | iOS当前实现 | 移动端整项验收条件 | 两端验收状态 | 负责人 | 完成时间 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
const columns = ['编号', '批次', '区域', '功能', '优先级', 'PC/Web关联', '映射范围', 'Android实现', 'Android验收', 'Android完成时间', 'iOS实现', 'iOS验收', 'iOS完成时间', '整项验收条件', '负责人', '整项状态', '整项完成时间'];
const csvRows = [columns];
for (const row of matrix.items) {
  const pc = row.pcWebBaseline ? `${row.id} ${row.pcWebBaseline.fullAcceptance ? '已关闭' : '未关闭'}` : row.pcWebRefs.join('、');
  lines.push('| ' + [row.id, row.executionBatch, `${row.feature}（${row.priority}）`, pc, state(row.android), state(row.ios), `${row.mapping}。${row.acceptanceCriteria}`, `Android ${row.android.acceptanceStatus}；iOS ${row.ios.acceptanceStatus}`, row.owner ?? '待认领', stamp(row)].map(escape).join(' | ') + ' |');
  csvRows.push([row.id,label(row.executionBatch),row.area,row.feature,row.priority,row.pcWebRefs.join(' '),row.mapping,state(row.android),row.android.acceptanceStatus,label(row.android.completedAt),state(row.ios),row.ios.acceptanceStatus,label(row.ios.completedAt),row.acceptanceCriteria,row.owner ?? '待认领',row.wholeItemStatus,label(row.completedAt)]);
}
lines.push('', '## 接口、组件与来源子清单', '',
  '| 平台 | 产品源码文件 | API、RPC、事件及桥接调用位置 | 历史记录 |', '| --- | --- | --- | --- |');
for (const platform of ['android', 'ios']) {
  const value = inventory[platform];
  lines.push(`| ${platform === 'android' ? 'Android' : 'iOS'} | ${value.components.length} | ${value.apiCalls.length} | ${value.history.length} |`);
}
lines.push('',
  'F156负责组件状态矩阵，F157负责接口逐方法、参数、返回和动作分支。源码文件与调用位置均有独立子编号，登记验收证据及完成时间。调用位点统计包含重复接口和动态表达式；动态分支、后台服务与新发现入口继续扩展子清单。', '',
  '[可筛选CSV](mobile-frontend-batch-20261113/Android-iOS-适配验收表.csv) · [逐项状态与源码定位](mobile-frontend-batch-20261113/item-matrix.json) · [接口、组件、历史和官方专属证据](mobile-frontend-batch-20261113/source-inventory.json)', '',
  '维护后运行 `node scripts/validate-mobile-progress.mjs --write` 同步 Markdown 和 CSV，再运行 `node scripts/validate-mobile-progress.mjs` 核对编号、状态、证据字段和时间。该命令检查台账一致性，功能通过由验收记录证明。', '',
  '## 已知问题', '',
  '当前Android与iOS的共享转录来自历史PC/Web资源版本，需按本次Android参考重新核对移动端语义和样式。两端源码存在未提交改动，只有绑定后续实际候选包后才能记运行通过。', '',
  '原版Android反编译有444个文件带错误标记、520处方法还原失败标记；10个原生库保留二进制。涉及这些位置的行为须结合Smali、进一步还原或实际运行核验。官方类声明和APK权限只能证明静态范围，服务器gate和配置另由F155追踪。', '',
  '参考包与反编译源码、旧移动工作区位于本机，路径写入JSON。共享仓库保存本表和定位索引，其他设备需另行取得对应参考材料和未提交源码快照。', '');
const markdown = lines.join('\n');
const csv = '\ufeff' + csvRows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
const outputs = [[tablePath, markdown], [path.join(directory, 'Android-iOS-适配验收表.csv'), csv]];
if (errors.length === 0) {
  for (const [file, text] of outputs) {
    if (process.argv.includes('--write')) fs.writeFileSync(file, text);
    else check(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text, `${file} 与JSON不一致，请先运行 --write`);
  }
}
console.log(JSON.stringify({ errors, ...counts }, null, 2));
if (errors.length) process.exitCode = 1;
