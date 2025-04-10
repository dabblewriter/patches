export interface JSONPatchOpHandler {
  like: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  apply(state: State, path: string, value: any): string | void;
  transform(state: State, other: CompactPatchOp, ops: CompactPatchOp[]): CompactPatchOp[];
  invert(state: State, op: CompactPatchOp, value: any, changedObj: any, isIndex: boolean): CompactPatchOp;
  compose?(state: State, value1: any, value2: any): any;
}

export interface JSONPatchOpHandlerMap {
  [key: string]: JSONPatchOpHandler;
}

export interface ApplyJSONPatchOptions {
  /**
   * Do not reject patches if error occurs (partial patching)
   */
  partial?: boolean;

  /**
   * Throw an exception if an error occurs when patching
   */
  strict?: boolean;

  /**
   * Stop on error and return the original object (without throwing an exception)
   */
  rigid?: boolean;

  /**
   * Don't log errors when they occurs during patching, if strict is not true, errors will be logged if this is false
   */
  silent?: boolean;

  /**
   * Saves the patch that caused the error to this property of the options object
   */
  error?: CompactPatchOp;

  /**
   * Apply changes at a given path prefix
   */
  atPath?: string;
}

export interface JSONPatchOp {
  op: string;
  path: string;
  from?: string;
  value?: any;
  soft?: boolean; // extension to JSON Patch to prevent an operation from overwriting existing data
}

export type PatchSymbol = '+' | '=' | '-' | '>' | '&' | 'T' | '^' | '~';
export type CompactPatchOp = [`${PatchSymbol}${string}`, any?, 1?];
export type CompactPatch = CompactPatchOp[];

export interface Root {
  '': any;
}

export type State = {
  root: Root;
  types: JSONPatchOpHandlerMap;
  cache: Set<any> | null;
};

export type Runner = (state: State) => any;
