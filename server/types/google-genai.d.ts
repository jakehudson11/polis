declare module "@google/genai" {
  export class GoogleGenAI {
    constructor(config: { apiKey?: string });
    models: {
      generateContent(request: any): Promise<any>;
    };
  }
}
