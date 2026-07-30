// Type declarations for the §9 pre-commit rail, so the test suite can import
// its internals and assert on them.
export declare const VAULT_FIELDS: Record<string, "keys" | "values">;
export declare const VAULT_NON_SECRET_FIELDS: string[];
export declare function vaultRoots(): string[];
export declare function collectVaultStrings(vault: unknown): string[];
