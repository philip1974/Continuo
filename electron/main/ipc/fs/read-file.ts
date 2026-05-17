import { lstat, readFile as fspReadFile } from 'node:fs/promises';
import { ERROR_CODES } from '../../../shared/error-codes';
import { fsError, mapNodeErrnoCode } from './path-utils';

export async function readFile(filePath: string): Promise<string> {
  let st;
  try {
    st = await lstat(filePath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${filePath}`);
  }
  if (st.isDirectory()) {
    throw fsError(ERROR_CODES.FS_NOT_FILE, `not a file: ${filePath}`);
  }
  try {
    return await fspReadFile(filePath, 'utf-8');
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `readFile failed: ${filePath}`);
  }
}
