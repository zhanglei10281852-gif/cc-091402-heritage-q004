import { createApp, createEngine } from "./app.js";
import { resolve } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const dataFile = process.env.DATA_FILE ?? resolve(process.cwd(), ".data", "approvals.json");

const engine = createEngine({ dataFile });
// 启动时立即扫描一次超时升级：截止时间持久化在状态文件中，重启后继续计算。
engine.sweepEscalations();
// 每分钟扫描一次，触发超时升级（升级不会越过缺失的前置签名）。
setInterval(() => engine.sweepEscalations(), 60_000).unref();

createApp(engine).listen(port, host, () => console.log(`借展审批服务已启动（数据文件：${dataFile}）`));
