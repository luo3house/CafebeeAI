/**
 * Typescript runner
 * @name tsx
 * @description run
 * @version 1 init: Initial commit
 * @version 2 feat(file): Add hash to save disk usage
 * @version 3 feat(file): Move build stuffs to os tmp dir
 * @version 4 fix: tmpdir in macos
 * @author Zenn Laurence
 */
let PROGRAM = "zencetsx"

const { exit } = require("process")
const { join, resolve, extname, relative, basename, isAbsolute } = require("path")
const { mkdir, stat, access, constants, unlink, rename } = require("fs/promises")
const { createHash } = require("crypto")
const { createReadStream, realpathSync } = require("fs")
const { tmpdir: tmpdirOS } = require("os")
const { execa } = require("execa")
const _ = require("esbuild") // ensure installed

const tmpdir = () => isAbsolute(tmpdirOS()) 
  ? realpathSync.native(tmpdirOS()) 
  : tmpdirOS();

async function main() {
  let argv = Array.from(process.argv)
  if (argv.includes(__filename)) {
    argv.splice(0, argv.indexOf(__filename) + 1)
  } else if (argv.includes(__filename.slice(0, -".js".length))) {
    argv.splice(0, argv.indexOf(__filename.slice(0, -".js".length)) + 1)
  }

  let script_path = argv.at(0)
  if (!script_path) return console.log("Usage: executable <script>")
  let dollar0 = argv.slice(1)

  let node_modules_dir = join(require.resolve("esbuild/package.json"), "../..")

  let src_script_file = ""
  {
    let input = resolve(script_path)
    let do_access_file = (src) => access(src, constants.R_OK)
    let src_script_files = [input, extname(input) ? input : `${input}.ts`, extname(input) ? input : `${input}.js`]
    for (let it of new Set(src_script_files)) {
      src_script_file = it
      try {
        await do_access_file(it)
        break
      } catch (err) {
        src_script_file = ""
      }
    }
    if (!src_script_file) {
      console.error(`Source not found: ${src_script_file}`)
      exit(1)
    }
  }

  let out_dir = join(join(tmpdir(), PROGRAM))
  await mkdir(out_dir, { recursive: true })

  // Compile to javascript
  let out_file_post_build = join(out_dir, `${basename(src_script_file)}_${parseInt((await stat(src_script_file)).mtimeMs)}.js`)
  {
    let ENTRYPOINT = `npx`
    let CMD = [`esbuild`, `--bundle`, `--platform=node`, `--sourcemap=inline`, `--outfile=${out_file_post_build}`, src_script_file]
    let shell = true
    let proc = execa(ENTRYPOINT, CMD, { stdin: "inherit", stderr: "inherit", shell })
    await proc.then((it) => (it.failed ? exit(it.exitCode) : 0))
  }

  // Hashing filename
  let out_file_post_hash = "MoveAhead"
  {
    /** @type string */
    // prettier-ignore
    let out_file_hash = await new Promise((resolve, reject) => {
      const hash = createHash("sha256")
      const stream = createReadStream(out_file_post_build)
      stream.on("data", (chunk) => hash.update(chunk))
      stream.on("end", () => resolve(hash.digest("hex")))
      stream.on("error", reject)
    })
    out_file_post_hash = join(out_dir, `${basename(src_script_file)}_${out_file_hash.slice(-6)}.js`)
    await unlink(out_file_post_hash).catch(() => 0)
    await rename(out_file_post_build, out_file_post_hash)
    console.log(`Built: ${relative(out_file_post_build, out_file_post_hash)}`)
    console.log(`Tempdir: ${out_dir}`)
    console.log(`Tempfile: ${out_file_post_hash}`)
  }

  {
    let CMD = ["node", "--enable-source-maps", out_file_post_hash, ...dollar0]
    let shell = true
    let proc = execa(CMD[0], CMD.slice(1), { env: { ...process.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit", shell })
    try {
      await proc
      await unlink(out_file_post_hash).catch(() => 0)
      exit(proc.exitCode)
    } catch (err) {
      await unlink(out_file_post_hash).catch(() => 0)
      exit(proc.exitCode)
    }
  }
}

main()
