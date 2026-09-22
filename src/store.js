import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// JSON 文件存储：所有变更经串行队列执行“读-改-写”，
// 落盘采用临时文件 + rename 原子替换。截止时间是绝对时刻，重启后直接沿用。
export class JsonStore {
  constructor(file) {
    this.file = file;
    this.tail = Promise.resolve();
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = readFileSync(this.file, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") return { seq: 0, applications: {} };
      throw error;
    }
  }

  #flush() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.file);
  }

  // 同一时刻只有一个 mutator 在执行，并发决定天然串行化，由业务层判重保证唯一有效决定
  mutate(fn) {
    const run = this.tail.then(async () => {
      try {
        const result = await fn(this.data);
        this.#flush();
        return result;
      } catch (error) {
        // 业务上“记录一次留痕后返回冲突”（如装箱后撤回被拒并留痕）：先落盘再抛出
        if (error?.committedMutation) this.#flush();
        throw error;
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  read() {
    return this.data;
  }
}
