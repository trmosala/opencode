import { DatabaseSync } from "node:sqlite"

// The official importer reads opencode-next.db through Bun's query API. Keep its transformation unchanged.
export class Database extends DatabaseSync {
  constructor(filename: string) {
    super(filename, { readOnly: true })
  }

  query(sql: string) {
    return this.prepare(sql)
  }

  run(sql: string) {
    this.exec(sql)
  }

  get inTransaction() {
    return this.isTransaction
  }
}
