import { PiSession, streamPiResponse } from "./stream";
import { TutorContext, TutorProvider, TutorResponse, TutorUpdateListener } from "./types";

export class PiTutorProvider implements TutorProvider {
  private constructor(private readonly session: PiSession) {}

  static async create(workspaceRoot: string): Promise<PiTutorProvider> {
    if (typeof process === "undefined" || !process.versions?.node) {
      throw new Error("The tutor requires a desktop Node.js extension host.");
    }
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
      throw new Error("The tutor requires Node.js 22.19 or newer. Please update VS Code.");
    }

    const packageName = "@earendil-works/pi-coding-agent";
    const { createAgentSession, DefaultResourceLoader, getAgentDir,
      ModelRuntime, SessionManager } = await import(/* webpackIgnore: true */ packageName);
    const fsModule = "node:fs/promises";
    const osModule = "node:os";
    const { readFile } = await import(/* webpackIgnore: true */ fsModule);
    const { homedir } = await import(/* webpackIgnore: true */ osModule);
    const configPath = process.env.CODETOUR_TUTOR_CONFIG ||
      homedir() + "/.config/codetour/tutor.json";
    let config;
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      throw new Error("Cannot read tutor config at " + configPath +
        ". Create it using tutor.config.example.json.");
    }
    if (!config || typeof config.provider !== "string" ||
        typeof config.model !== "string" || typeof config.apiKey !== "string" ||
        !config.apiKey.trim()) {
      throw new Error("Tutor config needs provider, model, and apiKey strings.");
    }
    const modelRuntime = await ModelRuntime.create();
    const model = modelRuntime.getModel(config.provider, config.model);
    if (!model) throw new Error("Unknown tutor provider/model in " + configPath);
    await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
    const loader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir: getAgentDir(),
      systemPromptOverride: () =>
        "You are a code-anchored programming tutor. Keep the programmer actively involved. " +
        "Investigate the repository as needed. Ask before modifying files or running destructive commands."
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(),
      resourceLoader: loader
    });
    return new PiTutorProvider(session);
  }

  respond(context: TutorContext, onUpdate?: TutorUpdateListener): Promise<TutorResponse> {
    return streamPiResponse(this.session, context, onUpdate);
  }

  dispose(): void {
    this.session.dispose();
  }
}
