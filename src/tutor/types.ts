export type TutorRole = "user" | "assistant";

export interface TutorMessage {
  role: TutorRole;
  content: string;
}

export type TutorUpdate =
  | { type: "text"; text: string }
  | { type: "status"; status: string };

export type TutorUpdateListener = (update: TutorUpdate) => void;

export interface TutorProvider {
  respond(context: TutorContext, onUpdate?: TutorUpdateListener): Promise<TutorResponse>;
  dispose(): void;
}

export interface TutorResponse {
  message: string;
}

export interface TutorContext {
  userMessage: string;
  workspaceRoot: string;
  stepIndex: number;
  stepDescription: string;
  file?: string;
  line?: number;
}
