// Type declarations for raw text imports (Vite/bundler feature)
declare module '*.txt?raw' {
    const content: string;
    export default content;
}
