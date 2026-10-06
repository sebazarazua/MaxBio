// Superficie pequeña utilizada por el preflight; saxen no publica tipos TypeScript.
declare module 'saxen' {
  export class Parser {
    on(
      event: 'openTag',
      callback: (
        name: string,
        attributes: () => Record<string, string>,
        decode: (text: string) => string,
      ) => void,
    ): this;
    on(event: 'closeTag', callback: (name: string) => void): this;
    on(event: 'text', callback: (text: string, decode: (text: string) => string) => void): this;
    on(event: 'error' | 'warn', callback: (error: Error) => void): this;
    on(event: 'attention', callback: (text: string) => void): this;
    parse(xml: string): Error | null;
  }
}
