export declare const prefixes: {
    info: string;
    error: string;
    warn: string;
    event: string;
};
export declare function bootstrap(message: string): void;
export declare function info(...message: unknown[]): void;
export declare function error(...message: unknown[]): void;
export declare function warn(...message: unknown[]): void;
