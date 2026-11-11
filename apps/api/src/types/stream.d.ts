/// <reference types="node" />

// Restore stream.Readable event listener overloads that are masked
// when @fastify/busboy augments stream.Readable with only 'limit'

declare module "stream" {
  interface Readable {
    on(event: "close", listener: () => void): this;
    on(event: "data", listener: (chunk: unknown) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pause", listener: () => void): this;
    on(event: "readable", listener: () => void): this;
    on(event: "resume", listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;

    once(event: "close", listener: () => void): this;
    once(event: "data", listener: (chunk: unknown) => void): this;
    once(event: "end", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pause", listener: () => void): this;
    once(event: "readable", listener: () => void): this;
    once(event: "resume", listener: () => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;

    addListener(event: "close", listener: () => void): this;
    addListener(event: "data", listener: (chunk: unknown) => void): this;
    addListener(event: "end", listener: () => void): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pause", listener: () => void): this;
    addListener(event: "readable", listener: () => void): this;
    addListener(event: "resume", listener: () => void): this;
    addListener(event: string | symbol, listener: (...args: unknown[]) => void): this;

    removeListener(event: "close", listener: () => void): this;
    removeListener(event: "data", listener: (chunk: unknown) => void): this;
    removeListener(event: "end", listener: () => void): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pause", listener: () => void): this;
    removeListener(event: "readable", listener: () => void): this;
    removeListener(event: "resume", listener: () => void): this;
    removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this;

    prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }
}

declare module "node:stream" {
  interface Readable {
    on(event: "close", listener: () => void): this;
    on(event: "data", listener: (chunk: unknown) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pause", listener: () => void): this;
    on(event: "readable", listener: () => void): this;
    on(event: "resume", listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;

    once(event: "close", listener: () => void): this;
    once(event: "data", listener: (chunk: unknown) => void): this;
    once(event: "end", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pause", listener: () => void): this;
    once(event: "readable", listener: () => void): this;
    once(event: "resume", listener: () => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;

    addListener(event: "close", listener: () => void): this;
    addListener(event: "data", listener: (chunk: unknown) => void): this;
    addListener(event: "end", listener: () => void): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pause", listener: () => void): this;
    addListener(event: "readable", listener: () => void): this;
    addListener(event: "resume", listener: () => void): this;
    addListener(event: string | symbol, listener: (...args: unknown[]) => void): this;

    removeListener(event: "close", listener: () => void): this;
    removeListener(event: "data", listener: (chunk: unknown) => void): this;
    removeListener(event: "end", listener: () => void): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pause", listener: () => void): this;
    removeListener(event: "readable", listener: () => void): this;
    removeListener(event: "resume", listener: () => void): this;
    removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this;

    prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }
}
