import type { Deck, NoteType } from './types';
export type ApiScope = 'content:read' | 'content:write' | 'types:write';
export interface FieldDefinition { id: string; name: string; required: boolean }
export interface ManagedNoteType extends NoteType {
  fieldDefinitions: FieldDefinition[];
  templates: (NoteType['templates'][number] & { id: string })[];
  version: number;
}
export interface ManagedDeck extends Deck { version: number }
export interface ManagedNote {
  id: string; noteTypeId: string; fields: Record<string,string>; tags: string[];
  version: number; contentFormat: 'plain' | 'html';
  cards: { id: string; deckId: string; templateId: string; suspended: boolean }[];
}
export interface NoteTypeInput {
  name: string; fieldDefinitions: FieldDefinition[];
  templates: { id: string; name: string; front: string; back: string }[];
  css: string;
}
export interface NoteInput { noteTypeId: string; deckId: string; fields: Record<string,string>; tags?: string[] }
export interface NotePatch { version: number; fields?: Record<string,string>; tags?: string[]; deckId?: string; suspended?: boolean }
export interface TokenInfo { id: string; name: string; scopes: ApiScope[]; createdAt: string; revoked: boolean }
