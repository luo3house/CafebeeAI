let { exit } = require("process")
let { join, resolve, extname, dirname, relative } = require("path")
let { cp, mkdir, stat, access, constants } = require("fs/promises")
let _ = require("esbuild") // ensure installed
let execa = require("execa").execa

async function main() {
  let argv = Array.from(process.argv)
  if (argv.includes(__filename)) {
    argv.splice(0, argv.indexOf(__filename) + 1)
  } else if (argv.includes(__filename.slice(0, -".js".length))) {
    argv.splice(0, argv.indexOf(__filename.slice(0, -".js".length)) + 1)
  }

  let req_out_file = argv.find((e) => e.startsWith("-o="))?.slice("-o=".length)
  let req_src_file = argv.find((e) => !/^\-\-?\w+=/.test(e))
  if (!req_src_file || !req_out_file) return console.log("Usage: executable <script> -o=<outfile>")
  req_src_file = resolve(req_src_file)
  req_out_file = resolve(req_out_file)

  let dollar0 = argv.slice(argv.findIndex((e) => e.startsWith("-o=")) + 1)
  let node_modules_dir = join(require.resolve("esbuild/package.json"), "../..")

  let src_file = ""
  {
    let input = req_src_file
    let do_access_file = (src) => access(src, constants.R_OK)
    let src_script_files = [input, extname(input) ? input : `${input}.ts`, extname(input) ? input : `${input}.js`]
    for (let it of new Set(src_script_files)) {
      src_file = it
      try {
        await do_access_file(it)
        break
      } catch (err) {
        src_file = ""
      }
    }
    if (!src_file) {
      console.error(`Source not found: ${src_file}`)
      exit(1)
    }
  }

  let out_dir = join(node_modules_dir, ".build")
  let out_file = join(out_dir, `${req_src_file}_${parseInt((await stat(src_file)).mtimeMs)}.js`)
  await mkdir(out_dir, { recursive: true })

  {
    let ENTRYPOINT = `npx`
    let CMD = [`esbuild`, `--bundle`, `--platform=node`, `--minify`, ...dollar0, `--outfile=${out_file}`, src_file]
    let shell = true
    let proc = execa(ENTRYPOINT, CMD, { stdin: "inherit", stdout: "inherit", stderr: "inherit", shell })
    await proc.then((it) => (it.failed ? exit(it.exitCode) : 0))
  }

  await mkdir(dirname(req_out_file), { recursive: true })
  await cp(out_file, req_out_file)
  console.log(`Built: ${relative(process.cwd(), req_out_file)}`)
}

main()
