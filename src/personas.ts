import { PERSONAS, type PersonaDefinition } from "./generated/personas.js";

export type Persona = PersonaDefinition;

export function listPersonas(): readonly Persona[] {
  return PERSONAS;
}

export function findPersona(id: string): Persona | undefined {
  return PERSONAS.find((persona) => persona.id === id);
}

/** ブラウザへ返してよい項目だけ。人物設定の本文は含めない / Only fields safe for the browser; never the system prompt */
export function toPublicPersona(persona: Persona): { id: string; name: string; description: string } {
  return { id: persona.id, name: persona.name, description: persona.description };
}
