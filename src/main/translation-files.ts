import { constants } from 'node:fs'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export async function saveBesideOriginal(source: string, originalPath: string): Promise<string> {
  const name = basename(originalPath, extname(originalPath))
  const bytes = await readFile(source)
  for (let number = 1; ; number++) {
    const destination = join(dirname(originalPath), `${name}.中文译文${number === 1 ? '' : ` (${number})`}.pdf`)
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Windows reports EPERM rather than EEXIST for an existing directory.
        if (await stat(destination).then(entry => entry.isDirectory(), () => false)) continue
        throw error
      }
      const existing = await readFile(destination).catch(() => null)
      if (existing?.equals(bytes)) return destination
    }
  }
}
