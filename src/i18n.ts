import { execFileSync } from "node:child_process";

export type Language = "en" | "zh";

export interface TranslationDictionary {
  [key: string]: string;
}

const translations: Record<Language, TranslationDictionary> = {
  en: {
    "repl.welcome": "DeepVibe REPL session started. Type /help for commands.\n",
    "repl.ready": "DeepVibe Chat ready.",
    "repl.hint": "Type /help for commands. Use /thoughts to inspect the last hidden reasoning trace.",
    "repl.mode.project": "Project mode: Git repository detected. File edits and agent actions are available.",
    "repl.mode.chat_only": "Chat-only mode: no Git repository detected. Normal conversation is available, but file edits are disabled until you enter a repository.",
    "repl.repo_init.prompt": "This directory is not a Git repository. Initialize one now so I can create and edit project files? [Y]es [N]o: ",
    "repl.repo_init.startup_prompt": "This directory is not a Git repository. Initialize one now so I can create and edit project files? [Y]es [N]o: ",
    "repl.repo_init.done": "Git repository initialized. Switched to project mode.",
    "repl.repo_init.declined": "Continuing in chat-only mode.",
    "repl.repo_init.failed": "Failed to initialize Git repository: {message}",
    "repl.status.title": "Status",
    "repl.status.mode": "Mode",
    "repl.status.profile": "Profile",
    "repl.status.session": "Session",
    "repl.status.plugins": "Plugins",
    "repl.status.workspace": "Workspace",
    "repl.status.workspace_path": "Workspace Path",
    "repl.status.ready": "Ready",
    "repl.status.hint": "Hint",
    "tui.chat.title": "Chat",
    "tui.input.title": "Input",
    "repl.thinking": "[Thinking...]",
    "repl.assistant": "Assistant:",
    "repl.thoughts.hidden": "[Thought process hidden. Type /thoughts to view the full trace.]",
    "repl.thoughts.empty": "No thought trace is available for the latest response.",
    "repl.thoughts.title": "Thought Trace",
    "repl.thoughts.return": "Press Enter, q, or Esc to return.",
    "repl.history.title": "Conversation History",
    "repl.viewer.controls": "Up/Down, j/k, PgUp/PgDn, Home/End, or mouse wheel scroll. Enter, q, or Esc closes.",
    "repl.interrupted": "\nSession interrupted. Type /quit to exit.",
    "repl.goodbye": "Goodbye!",
    "repl.preflight": "Analyzing project...",
    "repl.tool.running": "  Running {tool}...",
    "repl.panel.commands": "Commands",
    "repl.panel.assistant": "DeepVibe",
    "repl.panel.user": "You",
    "repl.panel.workspace": "Workspace",
    "repl.panel.error": "Error",
    "repl.panel.changes": "Proposed Changes",
    "repl.prompt": "deepvibe> ",
    "repl.prompt.multiline": "....> ",

    "cmd.help.title": "Commands:",
    "cmd.help.new": "  /new          Start a new session",
    "cmd.help.history": "  /history      Show conversation history",
    "cmd.help.sessions": "  /sessions     List all sessions",
    "cmd.help.switch": "  /switch <id>  Switch to a session",
    "cmd.help.effect": "  /effect [mode] Switch reasoning strength (low/medium/high/xhigh)",
    "cmd.help.model": "  /model [name] Switch model family (flash/pro)",
    "cmd.help.cost": "  /cost         Show session token and cost totals",
    "cmd.help.multiline": "  /multiline    Capture a multi-line prompt (empty line to send)",
    "cmd.help.thoughts": "  /thoughts     Open the latest hidden reasoning trace",
    "cmd.help.clear": "  /clear        Clear the screen",
    "cmd.help.help": "  /help         Show this help",
    "cmd.help.quit": "  /quit (/exit) Exit the REPL",

    "cmd.effect.usage": "Usage: /effect [low|medium|high|xhigh]",
    "cmd.effect.invalid": "Unknown reasoning strength: {value}. Use low, medium, high, or xhigh.",
    "cmd.effect.changed": "Reasoning strength set to {profile} ({model}/{reasoning}).",
    "cmd.model.usage": "Usage: /model [flash|pro]",
    "cmd.model.invalid": "Unknown model family: {value}. Use flash or pro.",
    "cmd.model.changed": "Model family set to {model} ({profile}/{reasoning}).",
    "cmd.cost.title": "Usage",
    "cmd.cost.empty": "No token usage has been recorded for this session yet.",
    "cmd.cost.turns": "Metered Turns",
    "cmd.cost.session_total": "Session Total",
    "cmd.cost.last_turn": "Last Turn",
    "cmd.multiline.started": "Multi-line capture started. End with an empty line or cancel with .cancel.",
    "cmd.multiline.started_fence": "Multi-line capture started. End with a closing fence or cancel with .cancel.",
    "cmd.multiline.canceled": "Multi-line capture canceled.",
    "cmd.new.started": "Started new session.",
    "cmd.history.empty": "No conversation history.",
    "cmd.sessions.empty": "No sessions.",
    "cmd.sessions.active": "active",
    "cmd.sessions.turns": "turns",
    "cmd.sessions.last": "last:",
    "cmd.switch.usage": "Usage: /switch <session-id>",
    "cmd.switch.not_found": "Session not found:",
    "cmd.switch.done": "Switched to session:",
    "cmd.unknown": "Unknown command: {command}. Type /help for commands.",

    "workspace.trust.prompt": "Workspace trust for \"{cwd}\": [S]andbox (recommended) / [F]ull access / [N] cancel: ",
    "workspace.trust.bad_choice": "Unrecognized choice. Use S (sandbox), F (full), or N (cancel).",

    "confirm.summary": "Summary:",
    "confirm.files": "Files:",
    "confirm.tool_changes": "Tool changes:",
    "confirm.prompt": "Apply changes? [A]ccept [R]eview [N]o: ",
    "confirm.accepted": "Changes applied.",
    "confirm.rejected": "Changes discarded.",
    "confirm.bad_choice": "Unrecognized choice. Use A (accept), R (review), or N (no).",

    "review.file_prompt": "Apply this file? [Y]es [S]kip [A]ll remaining [Q]uit: ",
    "review.selected": "Selected {selected} of {total} file(s) for apply.",

    "error.prefix": "Error:",
    "session.not_found": "Session not found: {id}. Starting with default session.",

    "error.GIT_REQUIRED": "DeepVibe requires a Git repository. Run `git init`, pass `--init`, or use `deepvibe chat` for the interactive setup flow.",
    "error.API_KEY_MISSING": "DeepSeek API key is not configured. Use `deepvibe config set api_key YOUR_KEY` to set it.",
    "error.CANCELED": "Execution was canceled.",
    "error.MODEL_EMPTY": "Model did not return a completion. Try again with a different instruction.",
    "error.CONFIG_INVALID": "Configuration error: {detail}"
  },
  zh: {
    "repl.welcome": "DeepVibe REPL 会话已启动。输入 /help 查看命令。\n",
    "repl.ready": "DeepVibe Chat 已准备就绪。",
    "repl.hint": "输入 /help 查看命令。输入 /thoughts 可查看上一条被收起的思考过程。",
    "repl.mode.project": "项目模式：已检测到 Git 仓库，可使用文件编辑和 agent 能力。",
    "repl.mode.chat_only": "纯聊天模式：当前目录不是 Git 仓库，可以正常聊天，但文件修改功能会在进入仓库后才启用。",
    "repl.repo_init.prompt": "当前目录不是 Git 仓库。是否现在初始化仓库，以便我创建和修改项目文件？[Y] 是 [N] 否：",
    "repl.repo_init.startup_prompt": "当前目录不是 Git 仓库。是否现在初始化仓库，以便我创建和修改项目文件？[Y] 是 [N] 否：",
    "repl.repo_init.done": "Git 仓库已初始化，现已切换到项目模式。",
    "repl.repo_init.declined": "继续保持纯聊天模式。",
    "repl.repo_init.failed": "初始化 Git 仓库失败：{message}",
    "repl.status.workspace": "工作区",
    "repl.status.workspace_path": "工作路径",
    "repl.thinking": "[思考中...]",
    "repl.assistant": "助手：",
    "repl.thoughts.hidden": "[思考过程已收起。输入 /thoughts 可查看完整内容。]",
    "repl.thoughts.empty": "最近一条回复没有可查看的思考过程。",
    "repl.thoughts.title": "思考过程",
    "repl.thoughts.return": "按回车、q 或 Esc 返回。",
    "repl.history.title": "对话历史",
    "repl.viewer.controls": "方向键、j/k、PgUp/PgDn、Home/End 或鼠标滚轮可滚动。回车、q 或 Esc 关闭。",
    "repl.interrupted": "\n会话已中断。输入 /quit 退出。",
    "repl.goodbye": "再见！",
    "repl.preflight": "正在分析项目...",
    "repl.tool.running": "  运行 {tool}...",
    "repl.prompt": "deepvibe> ",
    "tui.chat.title": "对话",
    "tui.input.title": "输入",

    "cmd.help.title": "命令：",
    "cmd.help.new": "  /new          开始新会话",
    "cmd.help.history": "  /history      显示对话历史",
    "cmd.help.sessions": "  /sessions     列出所有会话",
    "cmd.help.switch": "  /switch <id>  切换到指定会话",
    "cmd.help.effect": "  /effect [模式] 切换思考强度 (low/medium/high/xhigh)",
    "cmd.help.model": "  /model [名称] 切换模型系列 (flash/pro)",
    "cmd.help.cost": "  /cost         显示本会话 token 和费用统计",
    "cmd.help.multiline": "  /multiline    捕获多行输入（空行发送）",
    "cmd.help.thoughts": "  /thoughts     打开最近一条被收起的思考过程",
    "cmd.help.clear": "  /clear        清屏",
    "cmd.help.help": "  /help         显示帮助信息",
    "cmd.help.quit": "  /quit (/exit) 退出 REPL",

    "cmd.new.started": "已开始新会话。",
    "cmd.history.empty": "暂无对话历史。",
    "cmd.sessions.empty": "暂无会话。",
    "cmd.sessions.active": "当前",
    "cmd.sessions.turns": "轮对话",
    "cmd.sessions.last": "最近：",
    "cmd.switch.usage": "用法：/switch <会话ID>",
    "cmd.switch.not_found": "未找到会话：",
    "cmd.switch.done": "已切换到会话：",
    "cmd.unknown": "未知命令：{command}。输入 /help 查看命令。",

    "cmd.effect.usage": "用法：/effect [low|medium|high|xhigh]",
    "cmd.effect.invalid": "未知思考强度：{value}。请使用 low、medium、high 或 xhigh。",
    "cmd.effect.changed": "模型强度已设置为 {profile}（{model}/{reasoning}）。",
    "cmd.model.usage": "用法：/model [flash|pro]",
    "cmd.model.invalid": "未知模型系列：{value}。请使用 flash 或 pro。",
    "cmd.model.changed": "模型系列已设置为 {model}（{profile}/{reasoning}）。",
    "cmd.multiline.started": "已开始多行输入。空行结束，或输入 .cancel 取消。",
    "cmd.multiline.started_fence": "已开始多行输入。输入结束围栏，或输入 .cancel 取消。",
    "cmd.multiline.canceled": "已取消多行输入。",

    "workspace.trust.prompt": "工作区信任 \"{cwd}\"：[S] 沙盒（推荐）/ [F] 完全访问 / [N] 取消：",
    "workspace.trust.bad_choice": "无法识别的选择。请使用 S（沙盒）、F（完全访问）或 N（取消）。",

    "confirm.summary": "摘要：",
    "confirm.files": "文件：",
    "confirm.tool_changes": "工具变更：",
    "confirm.prompt": "应用变更？[A] 接受 [R] 审查 [N] 拒绝：",
    "confirm.accepted": "变更已应用。",
    "confirm.rejected": "变更已丢弃。",
    "confirm.bad_choice": "无法识别的选择。请使用 A（接受）、R（审查）或 N（拒绝）。",

    "review.file_prompt": "应用此文件？[Y] 是 [S] 跳过 [A] 全部保留 [Q] 退出：",
    "review.selected": "已选择 {total} 个文件中的 {selected} 个进行应用。",

    "error.prefix": "错误：",
    "session.not_found": "未找到会话：{id}，将使用默认会话。",

    "error.GIT_REQUIRED": "DeepVibe 需要在 Git 仓库中运行。请先执行 `git init`、传入 `--init`，或使用 `deepvibe chat` 进入交互式初始化流程。",
    "error.API_KEY_MISSING": "DeepSeek API Key 未配置。请使用 `deepvibe config set api_key 你的KEY` 进行设置。",
    "error.CANCELED": "执行已被取消。",
    "error.MODEL_EMPTY": "模型未返回结果，请尝试用不同的方式描述需求。",
    "error.CONFIG_INVALID": "配置错误：{detail}"
  }
};

export function t(key: string, lang: Language, params?: Record<string, string | number>): string {
  const dict = translations[lang] ?? translations.en;
  let text = dict[key] ?? translations.en[key] ?? key;

  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, "gu"), String(paramValue));
    }
  }

  return text;
}

export function detectLanguage(): Language {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? "";

  if (lang.startsWith("zh")) {
    return "zh";
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return "en";
  }

  try {
    const output = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "chcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 2000
    });
    if (/\b(936|54936|950|20936|10008)\b/.test(output)) {
      return "zh";
    }
  } catch {
    // shell detection failed
  }

  return "en";
}
