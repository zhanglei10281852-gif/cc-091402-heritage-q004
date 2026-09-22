import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 单文件 JSON 存储，带版本号条件写（CAS）。
 * 所有状态变更都在 mutate() 内完成：先按 expectedVersion 校验，
 * 再原子写盘（临时文件 + rename），从而保证并发决定只有一个生效。
 */
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    if (!existsSync(this.filePath)) {
      return { version: 0, state: { applications: {} } };
    }
    const raw = readFileSync(this.filePath, "utf8");
    if (!raw.trim()) return { version: 0, state: { applications: {} } };
    const parsed = JSON.parse(raw);
    return { version: parsed.version, state: parsed.state };
  }

  /**
   * @param expectedVersion 读入时的版本号；不匹配则抛 CAS_CONFLICT。
   * @returns {{version:number, result:*}}
   */
  mutate(expectedVersion, mutator) {
    const current = this.load();
    if (current.version !== expectedVersion) {
      const error = new Error("state_version_conflict");
      error.code = "CAS_CONFLICT";
      error.currentVersion = current.version;
      throw error;
    }
    const result = mutator(current.state);
    const nextVersion = current.version + 1;
    const payload = { version: nextVersion, state: current.state };
    if (this.filePath !== ":memory:") {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf8");
      renameSync(tmp, this.filePath);
    }
    return { version: nextVersion, result };
  }
}

/** 进程内存储，接口与 JsonStore 一致，供测试使用（不依赖主机隐藏状态）。 */
export class MemoryStore {
  constructor() {
    this.#data = { version: 0, state: { applications: {} } };
  }

  #data;

  load() {
    return this.#data;
  }

  mutate(expectedVersion, mutator) {
    if (this.#data.version !== expectedVersion) {
      const error = new Error("state_version_conflict");
      error.code = "CAS_CONFLICT";
      error.currentVersion = this.#data.version;
      throw error;
    }
    const result = mutator(this.#data.state);
    this.#data = { version: this.#data.version + 1, state: this.#data.state };
    return { version: this.#data.version, result };
  }
}
