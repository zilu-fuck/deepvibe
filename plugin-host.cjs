const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function createSafeConsole() {
  return {
    log: (...args) => console.log("[plugin]", ...args),
    warn: (...args) => console.warn("[plugin]", ...args),
    error: (...args) => console.error("[plugin]", ...args)
  };
}

function assertPluginSourceIsSupported(source, entryPath) {
  if (/\bimport\s+.+from\s+/u.test(source) || /^\s*import\s+/mu.test(source)) {
    throw new Error(`Static imports are not allowed in plugin sandbox: ${entryPath}`);
  }

  if (/\bimport\s*\(/u.test(source)) {
    throw new Error(`Dynamic import is not allowed in plugin sandbox: ${entryPath}`);
  }

  if (/\bexport\s+default\b/u.test(source)) {
    throw new Error(`Plugin sandbox currently supports only named exports such as "export function createTools".`);
  }
}

function transformPluginSource(source, entryPath) {
  const transformed = source.replace(
    /\bexport\s+(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu,
    (_match, asyncKeyword, name) => `globalThis.__pluginExports.${name} = ${asyncKeyword ?? ""}function ${name}(`
  );

  if (transformed === source) {
    throw new Error(
      `Plugin sandbox requires an exported function declaration such as "export function createTools" in ${entryPath}.`
    );
  }

  return transformed;
}

function loadPluginModuleSandboxed(entryPath) {
  const source = readFileSync(entryPath, "utf8");
  assertPluginSourceIsSupported(source, entryPath);
  const transformedSource = transformPluginSource(source, entryPath);
  const context = vm.createContext(
    {
      console: createSafeConsole(),
      TextEncoder,
      TextDecoder,
      URL,
      __pluginExports: Object.create(null)
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false
      }
    }
  );
  const script = new vm.Script(transformedSource, {
    filename: entryPath
  });

  script.runInContext(context, {
    timeout: 1000
  });

  return context.__pluginExports;
}

function resolvePluginDefinition(module, pluginName) {
  if (typeof module !== "object" || module === null) {
    throw new Error(`Plugin "${pluginName}" did not export an object module.`);
  }

  if (typeof module.createTools === "function") {
    return {
      createTools: module.createTools,
      initialize: typeof module.initialize === "function" ? module.initialize : undefined,
      dispose: typeof module.dispose === "function" ? module.dispose : undefined
    };
  }

  throw new Error(`Plugin "${pluginName}" must export createTools().`);
}

async function withPluginLifecycle(message, callback) {
  const module = loadPluginModuleSandboxed(message.entryPath);
  const plugin = resolvePluginDefinition(module, message.pluginName);
  let result;
  let operationError = null;

  try {
    if (plugin.initialize) {
      await plugin.initialize(message.context);
    }

    result = await callback(plugin);
  } catch (error) {
    operationError = normalizePluginError(error, "Unknown plugin lifecycle error.");
  }

  let disposeError = null;

  if (plugin.dispose) {
    try {
      await plugin.dispose();
    } catch (error) {
      disposeError = normalizePluginError(error, "Unknown plugin dispose error.");
    }
  }

  if (operationError && disposeError) {
    throw new Error(`${operationError.message} (dispose also failed: ${disposeError.message})`);
  }

  if (operationError) {
    throw operationError;
  }

  if (disposeError) {
    throw disposeError;
  }

  return result;
}

function normalizePluginError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }

  if (error && typeof error === "object" && typeof error.message === "string") {
    return new Error(error.message);
  }

  return new Error(fallbackMessage);
}

async function handleDescribe(message) {
  const tools = await withPluginLifecycle(message, async (plugin) => plugin.createTools(message.context));

  return {
    definitions: tools.map((tool) => tool.definition)
  };
}

async function handleExecute(message) {
  const content = await withPluginLifecycle(message, async (plugin) => {
    const tools = await plugin.createTools(message.context);
    const tool = tools.find((entry) => entry.definition?.function?.name === message.toolName);

    if (!tool) {
      throw new Error(`Plugin tool "${message.toolName}" was not found.`);
    }

    return tool.execute(message.argumentsJson, message.context);
  });

  return {
    content
  };
}

process.on("message", async (message) => {
  try {
    if (!message || typeof message !== "object") {
      throw new Error("Plugin host received an invalid message.");
    }

    const action = message.action;
    const result =
      action === "describe"
        ? await handleDescribe(message)
        : action === "execute"
          ? await handleExecute(message)
          : (() => {
              throw new Error(`Unsupported plugin host action: ${action}`);
            })();

    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown plugin host error"
    });
  } finally {
    process.disconnect?.();
    process.exit(0);
  }
});
