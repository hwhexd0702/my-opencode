import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { Log } from "../util/log"
import { LANGUAGE_EXTENSIONS } from "./language"
import z from "zod"
import type { LSPServer } from "./server"
import { NamedError } from "@opencode-ai/util/error"
import { withTimeout } from "../util/timeout"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Global } from "../global"
import fs from "fs/promises"

const DIAGNOSTICS_DEBOUNCE_MS = 150

export namespace LSPClient {
  const log = Log.create({ service: "lsp.client" })

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

  export type Diagnostic = VSCodeDiagnostic

  export const InitializeError = NamedError.create(
    "LSPInitializeError",
    z.object({
      serverID: z.string(),
    }),
  )

  export const Event = {
    Diagnostics: BusEvent.define(
      "lsp.client.diagnostics",
      z.object({
        serverID: z.string(),
        path: z.string(),
      }),
    ),
  }

  function createLoggingConnection(reader: StreamMessageReader, writer: StreamMessageWriter, logFile: string) {
    const connection = createMessageConnection(reader, writer)
    const originalSendRequest = connection.sendRequest.bind(connection)
    const originalSendNotification = connection.sendNotification.bind(connection)
    const originalOnNotification = connection.onNotification.bind(connection)
    const originalOnRequest = connection.onRequest.bind(connection)

    const logWriter = Bun.file(logFile).writer({ highWaterMark: 0 })

    const writeLog = (direction: string, method: string, data: any) => {
      const timestamp = new Date().toISOString()
      const msg = `[${timestamp}] ${direction} ${method}: ${JSON.stringify(data, null, 2)}\n`
      logWriter.write(msg)
    }

    ;(connection as any).sendRequest = (method: string, ...args: any[]) => {
      writeLog("SEND REQUEST", method, args)
      return originalSendRequest(method, ...args)
    }
    ;(connection as any).sendNotification = (method: string, params?: any) => {
      writeLog("SEND NOTIFICATION", method, params)
      return originalSendNotification(method, params)
    }
    ;(connection as any).onNotification = (method: string | ((...args: any[]) => any), handler?: any) => {
      if (typeof method === "function") {
        return originalOnNotification(method)
      }
      return originalOnNotification(method, (params: any) => {
        writeLog("RECV NOTIFICATION", method, params)
        return handler(params)
      })
    }
    ;(connection as any).onRequest = (method: string | ((...args: any[]) => any), handler?: any) => {
      if (typeof method === "function") {
        return originalOnRequest(method)
      }
      return originalOnRequest(method, (params: any) => {
        writeLog("RECV REQUEST", method, params)
        return handler(params)
      })
    }
    ;(connection as any).logWriter = logWriter

    return connection
  }

  export async function create(input: { serverID: string; server: LSPServer.Handle; root: string }) {
    const l = log.clone().tag("serverID", input.serverID)
    l.info("starting client")

    const logDir = path.join(Global.Path.log, "lsp")
    await fs.mkdir(logDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const commLogFile = input.server.logFile ?? path.join(logDir, `${input.serverID}-${timestamp}-comm.log`)

    const reader = new StreamMessageReader(input.server.process.stdout as any)
    const writer = new StreamMessageWriter(input.server.process.stdin as any)

    const connection = createLoggingConnection(reader, writer, commLogFile)

    const diagnostics = new Map<string, Diagnostic[]>()
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const filePath = Filesystem.normalizePath(fileURLToPath(params.uri))
      l.info("textDocument/publishDiagnostics", {
        path: filePath,
        count: params.diagnostics.length,
      })
      const exists = diagnostics.has(filePath)
      diagnostics.set(filePath, params.diagnostics)
      if (!exists && input.serverID === "typescript") return
      Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID })
    })
    connection.onRequest("window/workDoneProgress/create", (params) => {
      l.info("window/workDoneProgress/create", params)
      return null
    })
    connection.onRequest("workspace/configuration", async () => {
      return [input.server.initialization ?? {}]
    })
    connection.onRequest("client/registerCapability", async () => {})
    connection.onRequest("client/unregisterCapability", async () => {})
    connection.onRequest("workspace/workspaceFolders", async () => {
      const folders = input.server.workspaceFolders ?? [input.root]
      return folders.map((folder, index) => ({
        name: path.basename(folder) || `workspace-${index}`,
        uri: pathToFileURL(folder).href,
      }))
    })
    connection.listen()

    const workspaceFolders = input.server.workspaceFolders ?? [input.root]
    const folderObjects = workspaceFolders.map((folder, index) => ({
      name: path.basename(folder) || `workspace-${index}`,
      uri: pathToFileURL(folder).href,
    }))

    l.info("sending initialize", { logFile: commLogFile, workspaceFolders })
    await withTimeout(
      connection.sendRequest("initialize", {
        rootUri: pathToFileURL(input.root).href,
        processId: input.server.process.pid,
        workspaceFolders: folderObjects,
        initializationOptions: {
          ...input.server.initialization,
        },
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            publishDiagnostics: {
              versionSupport: true,
            },
          },
        },
      }),
      45_000,
    ).catch((err) => {
      l.error("initialize error", { error: err })
      throw new InitializeError(
        { serverID: input.serverID },
        {
          cause: err,
        },
      )
    })

    await connection.sendNotification("initialized", {})

    if (input.server.initialization) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: input.server.initialization,
      })
    }

    const files: {
      [path: string]: number
    } = {}

    const result = {
      root: input.root,
      get serverID() {
        return input.serverID
      },
      get connection() {
        return connection
      },
      notify: {
        async open(input: { path: string }) {
          input.path = path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path)
          const text = await Filesystem.readText(input.path)
          const extension = path.extname(input.path)
          const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

          const version = files[input.path]
          if (version !== undefined) {
            log.info("workspace/didChangeWatchedFiles", input)
            await connection.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [
                {
                  uri: pathToFileURL(input.path).href,
                  type: 2,
                },
              ],
            })

            const next = version + 1
            files[input.path] = next
            log.info("textDocument/didChange", {
              path: input.path,
              version: next,
            })
            await connection.sendNotification("textDocument/didChange", {
              textDocument: {
                uri: pathToFileURL(input.path).href,
                version: next,
              },
              contentChanges: [{ text }],
            })
            return
          }

          log.info("workspace/didChangeWatchedFiles", input)
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(input.path).href,
                type: 1,
              },
            ],
          })

          log.info("textDocument/didOpen", input)
          diagnostics.delete(input.path)
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri: pathToFileURL(input.path).href,
              languageId,
              version: 0,
              text,
            },
          })
          files[input.path] = 0
          return
        },
      },
      get diagnostics() {
        return diagnostics
      },
      async waitForDiagnostics(input: { path: string }) {
        const normalizedPath = Filesystem.normalizePath(
          path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path),
        )
        log.info("waiting for diagnostics", { path: normalizedPath })
        let unsub: () => void
        let debounceTimer: ReturnType<typeof setTimeout> | undefined
        return await withTimeout(
          new Promise<void>((resolve) => {
            unsub = Bus.subscribe(Event.Diagnostics, (event) => {
              if (event.properties.path === normalizedPath && event.properties.serverID === result.serverID) {
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = setTimeout(() => {
                  log.info("got diagnostics", { path: normalizedPath })
                  unsub?.()
                  resolve()
                }, DIAGNOSTICS_DEBOUNCE_MS)
              }
            })
          }),
          3000,
        )
          .catch(() => {})
          .finally(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            unsub?.()
          })
      },
      async shutdown() {
        l.info("shutting down")
        connection.end()
        connection.dispose()
        input.server.process.kill()
        ;(connection as any).logWriter?.end()
        input.server.logWriter?.end()
        l.info("shutdown")
      },
    }

    l.info("initialized", { logFile: commLogFile })

    return result
  }
}
