package com.pocketllm.pocketgit.git

import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.MergeCommand
import org.eclipse.jgit.api.MergeResult
import org.eclipse.jgit.api.ResetCommand
import org.eclipse.jgit.lib.ProgressMonitor
import org.eclipse.jgit.lib.Ref
import org.eclipse.jgit.lib.RefUpdate
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.RemoteRefUpdate
import org.eclipse.jgit.transport.URIish
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * JGit-backed git operations, deliberately policy-free (no UI, destructive actions are explicit
 * parameters per app design). Every op against the same repository serializes on the handle lock;
 * handles are path-keyed so re-ensuring an open repo reuses it.
 *
 * Verbs (upload = stage+commit+push, sync = fetch+fast-forward only, forceSync = overwrite local
 * with remote, clone = empty-dir fill via init+fetch+hard checkout). Merge commits are never
 * produced: sync is FF-only by construction.
 */
object GitSdk {

    private class Handle(val id: String, val path: String, val git: Git, val lock: Any = Any())

    private val handles = ConcurrentHashMap<String, Handle>()
    private val byPath = ConcurrentHashMap<String, Handle>()

    fun newOpId(): String = UUID.randomUUID().toString().replace("-", "")

    // ---------- repository lifecycle ----------

    fun ensureRepo(path: String, initialBranch: String, reservedSegment: String): JSONObject {
        if (path.isBlank()) throw Errors.GitFailure("invalid_path", "Repository path is empty.")
        val dir = File(path)
        if (!dir.exists() && !dir.mkdirs()) {
            throw Errors.GitFailure("invalid_path", "Cannot create directory: $path")
        }
        val branch = initialBranch.ifBlank { "main" }
        val key = dir.absolutePath
        byPath[key]?.let { existing ->
            if (handles.containsKey(existing.id)) {
                return JSONObject().put("handle", existing.id).put("path", existing.path)
            }
        }
        val git = if (File(dir, ".git").exists()) {
            try {
                Git.open(dir)
            } catch (e: Exception) {
                throw Errors.GitFailure("git_error", "Existing repository could not be opened: ${e.message}")
            }
        } else {
            val g = Git.init().setDirectory(dir).call()
            toBranch(g.repository, branch)
            g
        }
        ensureGitignore(dir, reservedSegment)
        val id = newOpId()
        val handle = Handle(id, key, git)
        handles[id] = handle
        byPath[key] = handle
        return JSONObject().put("handle", id).put("path", key)
    }

    fun close(handleId: String) {
        val h = handles.remove(handleId) ?: return
        byPath.remove(h.path)
        try {
            h.git.close()
        } catch (_: Exception) {
        }
    }

    /** Bare repository for the offline demo fixture (a push target with no working tree). */
    fun initBare(path: String): JSONObject {
        if (path.isBlank()) throw Errors.GitFailure("invalid_path", "Repository path is empty.")
        val dir = File(path)
        if (!dir.exists() && !dir.mkdirs()) {
            throw Errors.GitFailure("invalid_path", "Cannot create directory: $path")
        }
        if (File(dir, "HEAD").exists() || File(dir, ".git").exists()) {
            return JSONObject().put("path", dir.absolutePath).put("created", false)
        }
        val bare = Git.init().setBare(true).setDirectory(dir).call()
        bare.close()
        return JSONObject().put("path", dir.absolutePath).put("created", true)
    }

    fun status(handleId: String): JSONObject {
        val h = require(handleId)
        return synchronized(h.lock) {
            val st = h.git.status().call()
            val repo = h.git.repository
            val staged = st.changed
            val union = st.modified.toSet() + st.added.toSet() + st.untracked.toSet() +
                st.removed.toSet() + st.missing.toSet() + st.conflicting.toSet() + staged
            JSONObject()
                .put("hasHead", repo.resolve("HEAD") != null)
                .put("branch", repo.branch ?: "")
                .put("clean", union.isEmpty())
                .put("changed", union.size)
                .put("unmerged", JSONArray(st.conflicting))
                .put("modified", JSONArray(st.modified))
                .put("staged", JSONArray(staged))
                .put("added", JSONArray(st.added))
                .put("untracked", JSONArray(st.untracked))
                .put("removed", JSONArray(st.removed))
                .put("missing", JSONArray(st.missing))
        }
    }

    fun setRemote(handleId: String, name: String, url: String): JSONObject {
        val h = require(handleId)
        val remoteName = name.ifBlank { "origin" }
        synchronized(h.lock) { writeRemote(h, remoteName, url) }
        return JSONObject().put("ok", true)
    }

    fun getRemote(handleId: String, name: String): JSONObject {
        val h = require(handleId)
        val url = synchronized(h.lock) {
            h.git.repository.config.getString("remote", name.ifBlank { "origin" }, "url")
        }
        return JSONObject().put("url", url ?: JSONObject.NULL)
    }

    fun lsRemote(payload: JSONObject): JSONObject {
        val url = reqStr(payload, "url")
        val cmd = Git.lsRemoteRepository().setRemote(url).setHeads(true)
        Transports.apply(cmd, payload)
        val refs: Collection<Ref> = cmd.call()
        val arr = JSONArray()
        refs.forEach { ref ->
            if (ref.name.startsWith("refs/heads/")) {
                arr.put(
                    JSONObject()
                        .put("name", ref.name.removePrefix("refs/heads/"))
                        .put("sha", ref.objectId?.name ?: ""),
                )
            }
        }
        return JSONObject().put("branches", arr)
    }

    // ---------- verbs ----------

    fun clone(payload: JSONObject, emit: (String) -> Unit, flag: AtomicBoolean): JSONObject {
        val url = reqStr(payload, "url")
        val target = reqStr(payload, "targetPath")
        val branch = reqOptStr(payload, "branch").ifBlank { "main" }
        val reserved = reqOptStr(payload, "reservedSegment")

        val dir = File(target)
        val blockers = (dir.list() ?: emptyArray())
            .filter { it != reserved && it != ".gitignore" && it != ".git" }
        if (blockers.isNotEmpty()) {
            throw Errors.GitFailure(
                "target_not_empty",
                "Clone needs an empty project. The folder already contains: " + blockers.take(5).joinToString(", "),
            )
        }

        val ensured = ensureRepo(target, branch, reserved)
        val h = require(ensured.getString("handle"))
        return synchronized(h.lock) {
            writeRemote(h, "origin", url)
            emit("Connecting")
            val fetch = h.git.fetch().setRemote("origin")
                .setRefSpecs(RefSpec("+refs/heads/*:refs/remotes/origin/*"))
            Transports.apply(fetch, payload)
            fetch.setProgressMonitor(monitor(emit, flag))
            fetch.call()
            checkCancelled(flag)

            val remoteRef = "refs/remotes/origin/$branch"
            val remoteOid = h.git.repository.resolve(remoteRef)
            if (remoteOid == null) {
                val hasAnyRemote = h.git.repository.refDatabase
                    .getRefsByPrefix("refs/remotes/origin/").isNotEmpty()
                if (hasAnyRemote) {
                    throw Errors.GitFailure("branch_not_found", "Branch '$branch' was not found on the remote.")
                }
                // Empty remote: keep the repo unborn; the first upload will create the branch.
                return@synchronized JSONObject().put("path", h.path).put("branch", branch)
            }
            emit("Checking out")
            createAndSwitch(h, branch, remoteRef)
            writeBranchConfig(h, branch, "origin")
            JSONObject().put("path", h.path).put("branch", branch)
        }
    }

    fun upload(payload: JSONObject, emit: (String) -> Unit, flag: AtomicBoolean): JSONObject {
        val h = require(reqStr(payload, "handle"))
        val message = reqStr(payload, "message")
        val branch = reqStr(payload, "branch")
        val authorName = reqOptStr(payload, "authorName").ifBlank { "app" }
        val authorEmail = reqOptStr(payload, "authorEmail").ifBlank { "app@localhost" }
        val force = payload.optBoolean("force", false)
        val remoteUrl = reqOptStr(payload, "remoteUrl")

        return synchronized(h.lock) {
            val repo = h.git.repository
            if (remoteUrl.isNotBlank()) writeRemote(h, "origin", remoteUrl)

            val st = h.git.status().call()
            if (st.conflicting.isNotEmpty()) throw Errors.SyncConflict()
            val dirty = st.modified.isNotEmpty() || st.added.isNotEmpty() || st.untracked.isNotEmpty() ||
                st.removed.isNotEmpty() || st.missing.isNotEmpty()
            val born = repo.resolve("HEAD") != null

            var commitSha: String? = null
            if (dirty) {
                emit("Committing")
                h.git.add().addFilepattern(".").call()
                h.git.add().setUpdate(true).addFilepattern(".").call()
                val commit = h.git.commit()
                    .setMessage(message)
                    .setAuthor(authorName, authorEmail)
                    .setCommitter(authorName, authorEmail)
                    .call()
                commitSha = commit.name
            } else if (!born) {
                return@synchronized JSONObject()
                    .put("committed", false)
                    .put("pushed", false)
                    .put("reason", "nothing_to_upload")
            }

            emit("Pushing")
            val push = h.git.push().setRemote("origin").setRefSpecs(RefSpec("HEAD:refs/heads/$branch"))
            if (force) push.setForce(true)
            Transports.apply(push, payload)
            push.setProgressMonitor(monitor(emit, flag))
            val result = push.call().firstOrNull()
            checkCancelled(flag)

            val updates = result?.remoteUpdates ?: emptyList()
            if (flag.get()) throw Errors.CancelledSignal()
            val bad = updates.firstOrNull {
                it.status != RemoteRefUpdate.Status.OK && it.status != RemoteRefUpdate.Status.UP_TO_DATE
            }
            if (bad != null) {
                if (bad.status == RemoteRefUpdate.Status.REJECTED_NONFASTFORWARD) throw Errors.PushRejected()
                val msg = bad.message ?: "The remote rejected the push."
                if (msg.contains("permission", true) || msg.contains("protected", true) ||
                    msg.contains("403", true) || msg.contains("401", true)
                ) {
                    throw Errors.GitFailure("auth_failed", "The remote refused the push: $msg")
                }
                throw Errors.PushRejected()
            }
            val upToDate = updates.all { it.status == RemoteRefUpdate.Status.UP_TO_DATE }
            val nothingToPush = commitSha == null && upToDate
            JSONObject().apply {
                put("committed", commitSha != null)
                put("pushed", !nothingToPush)
                commitSha?.let { put("commitSha", it) }
                if (nothingToPush) put("reason", "nothing_to_upload")
            }
        }
    }

    fun sync(payload: JSONObject, emit: (String) -> Unit, flag: AtomicBoolean): JSONObject {
        val h = require(reqStr(payload, "handle"))
        val branch = reqStr(payload, "branch")
        val remoteUrl = reqOptStr(payload, "remoteUrl")

        return synchronized(h.lock) {
            val repo = h.git.repository
            if (remoteUrl.isNotBlank()) writeRemote(h, "origin", remoteUrl)

            emit("Fetching")
            val fetch = h.git.fetch().setRemote("origin")
                .setRefSpecs(RefSpec("+refs/heads/$branch:refs/remotes/origin/$branch"))
            Transports.apply(fetch, payload)
            fetch.setProgressMonitor(monitor(emit, flag))
            fetch.call()
            checkCancelled(flag)

            val remoteRef = "refs/remotes/origin/$branch"
            val remoteOid = repo.resolve(remoteRef)
                ?: throw Errors.GitFailure("branch_not_found", "Branch '$branch' was not found on the remote.")

            val born = repo.resolve("HEAD") != null
            if (!born || repo.resolve("refs/heads/$branch") == null) {
                // Nothing local on this branch (or unborn repo): adopt the remote state wholesale.
                emit("Checking out")
                createAndSwitch(h, branch, remoteRef)
                writeBranchConfig(h, branch, "origin")
                return@synchronized JSONObject()
                    .put("updated", true)
                    .put("branch", branch)
                    .put("commitSha", remoteOid.name)
            }

            if (repo.branch != branch) {
                emit("Switching branch")
                try {
                    h.git.checkout().setName(branch).call()
                } catch (e: org.eclipse.jgit.api.errors.CheckoutConflictException) {
                    throw Errors.SyncConflict()
                }
                if (repo.branch != branch) throw Errors.SyncConflict()
            }

            emit("Merging")
            val pull = h.git.pull()
                .setRemote("origin")
                .setRemoteBranchName(branch)
                .setFastForward(MergeCommand.FastForwardMode.FF_ONLY)
            Transports.apply(pull, payload)
            val res = try {
                pull.call()
            } catch (e: org.eclipse.jgit.api.errors.CheckoutConflictException) {
                throw Errors.SyncConflict()
            }
            checkCancelled(flag)

            val headOid = repo.resolve("HEAD")
            val mergeStatus = res.mergeResult?.mergeStatus
            if (mergeStatus == MergeResult.MergeStatus.FAST_FORWARD) {
                JSONObject()
                    .put("updated", true)
                    .put("branch", branch)
                    .put("commitSha", headOid?.name ?: remoteOid.name)
            } else if (mergeStatus == null || mergeStatus == MergeResult.MergeStatus.ALREADY_UP_TO_DATE) {
                JSONObject()
                    .put("updated", false)
                    .put("branch", branch)
            } else {
                throw Errors.SyncConflict()
            }
        }
    }

    fun forceSync(payload: JSONObject, emit: (String) -> Unit, flag: AtomicBoolean): JSONObject {
        val h = require(reqStr(payload, "handle"))
        val branch = reqStr(payload, "branch")
        val remoteUrl = reqOptStr(payload, "remoteUrl")

        return synchronized(h.lock) {
            val repo = h.git.repository
            if (remoteUrl.isNotBlank()) writeRemote(h, "origin", remoteUrl)

            emit("Fetching")
            val fetch = h.git.fetch().setRemote("origin")
                .setRefSpecs(RefSpec("+refs/heads/$branch:refs/remotes/origin/$branch"))
            Transports.apply(fetch, payload)
            fetch.setProgressMonitor(monitor(emit, flag))
            fetch.call()
            checkCancelled(flag)

            val remoteRef = "refs/remotes/origin/$branch"
            val remoteOid = repo.resolve(remoteRef)
                ?: throw Errors.GitFailure("branch_not_found", "Branch '$branch' was not found on the remote.")

            emit("Applying remote state")
            createAndSwitch(h, branch, remoteRef)
            writeBranchConfig(h, branch, "origin")

            JSONObject()
                .put("updated", true)
                .put("branch", branch)
                .put("commitSha", remoteOid.name)
        }
    }

    // ---------- helpers ----------

    private fun require(handleId: String): Handle =
        handles[handleId] ?: throw Errors.GitFailure("bad_handle", "Repository handle is not open.")

    private fun checkCancelled(flag: AtomicBoolean) {
        if (flag.get()) throw Errors.CancelledSignal()
    }

    private fun monitor(emit: (String) -> Unit, flag: AtomicBoolean): ProgressMonitor =
        object : ProgressMonitor {
            override fun start(totalTasks: Int) {}

            override fun beginTask(taskName: String?, totalWork: Int) {
                if (!taskName.isNullOrEmpty()) emit(taskName)
            }

            override fun update(completed: Int) {}

            override fun endTask() {}

            override fun isCancelled(): Boolean = flag.get()
        }

    /** Force local branch == remote ref == working tree (unborn-safe, dirty-safe). */
    private fun createAndSwitch(h: Handle, branch: String, startPoint: String) {
        val repo = h.git.repository
        val oid = repo.resolve(startPoint) ?: throw Errors.GitFailure("git_error", "Start point $startPoint is missing.")
        val local = "refs/heads/$branch"
        val update = repo.updateRef(local)
        update.setForceUpdate(true)
        update.setNewObjectId(oid)
        val result = update.update()
        if (result != RefUpdate.Result.NEW && result != RefUpdate.Result.FAST_FORWARD &&
            result != RefUpdate.Result.FORCED && result != RefUpdate.Result.NO_CHANGE
        ) {
            throw Errors.GitFailure("git_error", "Could not update $local ($result).")
        }
        repo.updateRef("HEAD").link(local)
        h.git.reset().setMode(ResetCommand.ResetType.HARD).setRef(local).call()
    }

    /** Point an unborn HEAD at refs/heads/<branch> so the first commit lands there. */
    private fun toBranch(repo: Repository, branch: String) {
        if (repo.resolve("HEAD") != null) return
        val target = "refs/heads/$branch"
        val head = repo.findRef("HEAD")
        val current = head?.target?.name
        if (current != target) {
            repo.updateRef("HEAD").link(target)
        }
    }

    private fun writeRemote(h: Handle, name: String, url: String) {
        if (url.isBlank()) throw Errors.GitFailure("invalid_url", "Remote URL is empty.")
        val uri = try {
            URIish(url)
        } catch (e: Exception) {
            throw Errors.GitFailure("invalid_url", "The remote URL is not valid.")
        }
        val scheme = uri.scheme ?: ""
        if (scheme.startsWith("http") && !uri.user.isNullOrEmpty()) {
            throw Errors.GitFailure(
                "embedded_credentials",
                "URLs with embedded credentials are not supported. Remove the user info from the URL and pick a credential instead.",
            )
        }
        val cfg = h.git.repository.config
        cfg.setString("remote", name, "url", url)
        val fetchRefSpec = "+refs/heads/*:refs/remotes/$name/*"
        val current: List<String> = cfg.getStringList("remote", name, "fetch")?.toList() ?: emptyList()
        if (!current.contains(fetchRefSpec)) {
            cfg.setStringList("remote", name, "fetch", current + fetchRefSpec)
        }
        cfg.save()
    }

    private fun writeBranchConfig(h: Handle, branch: String, remoteName: String) {
        val cfg = h.git.repository.config
        cfg.setString("branch", branch, "remote", remoteName)
        cfg.setString("branch", branch, "merge", "refs/heads/$branch")
        cfg.save()
    }

    private fun ensureGitignore(dir: File, reservedSegment: String) {
        if (reservedSegment.isBlank()) return
        val f = File(dir, ".gitignore")
        val text = if (f.exists()) f.readText() else ""
        val lines = text.split('\n').map { it.trim() }
        if (lines.contains("$reservedSegment/") || lines.contains(reservedSegment)) return
        f.writeText(if (text.isEmpty()) "$reservedSegment/\n" else text.trimEnd() + "\n$reservedSegment/\n")
    }

    private fun reqStr(j: JSONObject, key: String): String {
        val value = j.optString(key, "")
        if (value.isBlank()) throw Errors.GitFailure("invalid_payload", "Missing required parameter: $key")
        return value
    }

    private fun reqOptStr(j: JSONObject, key: String): String = j.optString(key, "")
}
