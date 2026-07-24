// RN 0.85 ships the "strict API" type surface, which only exposes the public
// entry point. `Blob` is not part of it: RN installs the global from
// InitializeCore, which workers deliberately do not run, so worker code has to
// deep-import the implementation module — and that module has no published
// types. Declare the slice of it the example uses.
declare module 'react-native/Libraries/Blob/Blob' {
  export interface BlobOptions {
    type?: string;
    lastModified?: number;
  }

  export default class Blob {
    constructor(parts?: Array<Blob | string>, options?: BlobOptions);
    readonly size: number;
    readonly type: string;
    slice(start?: number, end?: number): Blob;
    close(): void;
  }
}
