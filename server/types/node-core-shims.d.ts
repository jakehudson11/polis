declare module "node:fs/promises" {
  export type FileHandle = any;
  export function readFile(path: any, options?: any): Promise<any>;
  const fsPromises: {
    readFile: typeof readFile;
  };
  export default fsPromises;
}

declare module "node:zlib" {
  export type InputType = any;
  const zlib: any;
  export default zlib;
}
