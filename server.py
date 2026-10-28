import os
import sys
import json
import uuid
import time
import shutil
import threading
import subprocess
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("PORT", 3000))
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORT_DIR = os.path.join(ROOT_DIR, ".exports_tmp")
os.makedirs(EXPORT_DIR, exist_ok=True)

# Active render jobs: jobId -> dict
RENDER_JOBS = {}
JOBS_LOCK = threading.Lock()


def detect_nvenc():
    """Test if NVIDIA h264_nvenc hardware encoder is operational."""
    try:
        res = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x256:d=0.1:r=30",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "h264_nvenc",
                "-f",
                "null",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=6,
        )
        return res.returncode == 0
    except Exception:
        return False


HAS_NVENC = detect_nvenc()
ENCODER_NAME = "h264_nvenc (NVIDIA GPU)" if HAS_NVENC else "libx264 (CPU Fast)"
print(f"[LyricTok Python Engine] Video Encoder Selected: {ENCODER_NAME}")


def build_ffmpeg_cmd(fps, audio_path, trim_start, duration, output_path, use_nvenc):
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        # Input 0: Piped JPEG frames from browser canvas
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-framerate",
        str(fps),
        "-i",
        "-",
    ]

    has_audio = audio_path and os.path.exists(audio_path) and os.path.getsize(audio_path) > 0
    if has_audio:
        cmd += [
            "-ss",
            f"{trim_start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            audio_path,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
        ]

    if use_nvenc:
        cmd += [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-rc",
            "vbr",
            "-cq",
            "19",
            "-b:v",
            "12M",
            "-maxrate",
            "18M",
            "-bufsize",
            "24M",
        ]
    else:
        cmd += [
            "-c:v",
            "libx264",
            "-preset",
            "superfast",
            "-crf",
            "18",
            "-maxrate",
            "16M",
            "-bufsize",
            "24M",
        ]

    cmd += [
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-r",
        str(fps),
        "-fps_mode",
        "cfr",
    ]

    if has_audio:
        cmd += [
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-shortest",
        ]

    cmd += [
        "-movflags",
        "+faststart",
        output_path,
    ]
    return cmd


class StudioRequestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ".json": "application/json; charset=utf-8",
        ".srt": "text/plain; charset=utf-8",
        ".lrc": "text/plain; charset=utf-8",
        ".vtt": "text/vtt; charset=utf-8",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        # Never let the browser cache app files; stale JS caused old export code to keep running.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, format, *args):
        # Suppress noisy per-chunk logs
        if "/api/render/chunk" in (self.path or ""):
            return
        super().log_message(format, *args)

    def send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/render/capabilities":
            return self.send_json(
                200,
                {
                    "ok": True,
                    "python": True,
                    "encoder": "h264_nvenc" if HAS_NVENC else "libx264",
                    "encoderLabel": ENCODER_NAME,
                },
            )

        if parsed.path.startswith("/api/render/download/"):
            job_id = parsed.path.split("/api/render/download/")[-1].strip("/")
            qs = urllib.parse.parse_qs(parsed.query)
            download_name = qs.get("filename", [f"lyrictok_{job_id}.mp4"])[0]
            download_name = "".join(c for c in download_name if c.isalnum() or c in "._- ") or "lyrictok_video.mp4"

            with JOBS_LOCK:
                job = RENDER_JOBS.get(job_id)

            if not job or not os.path.exists(job["output_path"]):
                self.send_error(404, "Rendered video not found")
                return

            mp4_path = job["output_path"]
            file_size = os.path.getsize(mp4_path)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(file_size))
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            with open(mp4_path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
            return

        if parsed.path.startswith("/api/bg/frame/"):
            parts = parsed.path[len("/api/bg/frame/"):].strip("/").split("/")
            if len(parts) == 2 and parts[0].isalnum() and parts[1].isdigit():
                fpath = os.path.join(EXPORT_DIR, f"bg_{parts[0]}", f"{int(parts[1]) + 1:06d}.jpg")
                if os.path.exists(fpath):
                    with open(fpath, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_error(404, "Background frame not found")
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len > 0 else b""

        if parsed.path == "/api/render/start":
            job_id = uuid.uuid4().hex[:12]
            fps = int(qs.get("fps", ["60"])[0])
            trim_start = float(qs.get("trimStart", ["0"])[0])
            trim_end = float(qs.get("trimEnd", ["24"])[0])
            ext = qs.get("ext", ["wav"])[0].lstrip(".")
            duration = max(0.5, trim_end - trim_start)

            audio_path = os.path.join(EXPORT_DIR, f"audio_{job_id}.{ext}")
            output_path = os.path.join(EXPORT_DIR, f"render_{job_id}.mp4")

            if body:
                with open(audio_path, "wb") as f:
                    f.write(body)
            else:
                audio_path = None

            cmd = build_ffmpeg_cmd(fps, audio_path, trim_start, duration, output_path, HAS_NVENC)
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=10**7,
            )

            stderr_lines = []

            def drain_stderr(p, sink):
                try:
                    for line in iter(p.stderr.readline, b""):
                        sink.append(line.decode("utf-8", errors="replace"))
                except Exception:
                    pass

            t = threading.Property if False else threading.Thread(target=drain_stderr, args=(proc, stderr_lines), daemon=True)
            t.start()

            with JOBS_LOCK:
                RENDER_JOBS[job_id] = {
                    "proc": proc,
                    "audio_path": audio_path,
                    "output_path": output_path,
                    "stderr": stderr_lines,
                    "created_at": time.time(),
                }

            return self.send_json(
                200,
                {
                    "ok": True,
                    "jobId": job_id,
                    "encoder": ENCODER_NAME,
                },
            )

        if parsed.path == "/api/render/chunk":
            job_id = qs.get("jobId", [""])[0]
            with JOBS_LOCK:
                job = RENDER_JOBS.get(job_id)

            if not job:
                return self.send_json(404, {"ok": False, "error": "Render job not found"})

            proc = job["proc"]
            if proc.poll() is not None:
                err_msg = "".join(job["stderr"][-10:])
                return self.send_json(500, {"ok": False, "error": f"FFmpeg exited early: {err_msg}"})

            try:
                proc.stdin.write(body)
                proc.stdin.flush()
                return self.send_json(200, {"ok": True})
            except Exception as e:
                err_msg = "".join(job["stderr"][-10:])
                return self.send_json(500, {"ok": False, "error": f"{str(e)} | {err_msg}"})

        if parsed.path == "/api/render/finish":
            job_id = qs.get("jobId", [""])[0]
            filename = qs.get("filename", [f"lyrictok_{job_id}.mp4"])[0]
            with JOBS_LOCK:
                job = RENDER_JOBS.get(job_id)

            if not job:
                return self.send_json(404, {"ok": False, "error": "Render job not found"})

            proc = job["proc"]
            try:
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.close()
                proc.wait(timeout=120)
            except Exception as e:
                proc.kill()
                return self.send_json(500, {"ok": False, "error": f"FFmpeg finalize timeout: {e}"})

            # Cleanup temp audio
            if job["audio_path"] and os.path.exists(job["audio_path"]):
                try:
                    os.remove(job["audio_path"])
                except Exception:
                    pass

            if proc.returncode != 0 or not os.path.exists(job["output_path"]):
                err_msg = "".join(job["stderr"][-15:])
                return self.send_json(500, {"ok": False, "error": f"FFmpeg encoding failed: {err_msg}"})

            safe_q = urllib.parse.quote(filename)

            # Save directly into the user's Downloads folder (server is local), so the
            # file always gets a proper name even if the browser renames downloads.
            saved_path = None
            try:
                safe_name = "".join(c for c in filename if c.isalnum() or c in "._- ") or "lyrictok_video.mp4"
                if not safe_name.lower().endswith(".mp4"):
                    safe_name += ".mp4"
                dl_dir = os.path.join(os.path.expanduser("~"), "Downloads")
                os.makedirs(dl_dir, exist_ok=True)
                base, ext = os.path.splitext(safe_name)
                saved_path = os.path.join(dl_dir, safe_name)
                n = 1
                while os.path.exists(saved_path):
                    saved_path = os.path.join(dl_dir, f"{base} ({n}){ext}")
                    n += 1
                shutil.copyfile(job["output_path"], saved_path)
            except Exception:
                saved_path = None

            return self.send_json(
                200,
                {
                    "ok": True,
                    "downloadUrl": f"/api/render/download/{job_id}?filename={safe_q}",
                    "sizeBytes": os.path.getsize(job["output_path"]),
                    "savedPath": saved_path,
                },
            )


        if parsed.path == "/api/render/cancel":
            job_id = qs.get("jobId", [""])[0]
            with JOBS_LOCK:
                job = RENDER_JOBS.pop(job_id, None)

            if job:
                try:
                    if job["proc"].stdin and not job["proc"].stdin.closed:
                        job["proc"].stdin.close()
                    job["proc"].kill()
                except Exception:
                    pass
                for p in (job.get("audio_path"), job.get("output_path")):
                    if p and os.path.exists(p):
                        try:
                            os.remove(p)
                        except Exception:
                            pass

            return self.send_json(200, {"ok": True})

        if parsed.path == "/api/bg/prepare":
            # Decode the background video sequentially with FFmpeg (much faster than
            # seeking a <video> element once per frame), looped and cover-cropped to canvas size.
            if not body:
                return self.send_json(400, {"ok": False, "error": "No video uploaded"})
            fps = int(qs.get("fps", ["30"])[0])
            start = max(0.0, float(qs.get("start", ["0"])[0]))
            frames = max(1, int(qs.get("frames", ["1"])[0]))
            w = max(2, int(qs.get("w", ["1080"])[0])) // 2 * 2
            h = max(2, int(qs.get("h", ["1920"])[0])) // 2 * 2
            prep_id = uuid.uuid4().hex[:12]
            frame_dir = os.path.join(EXPORT_DIR, f"bg_{prep_id}")
            os.makedirs(frame_dir, exist_ok=True)
            video_path = os.path.join(EXPORT_DIR, f"bgsrc_{prep_id}.bin")
            with open(video_path, "wb") as f:
                f.write(body)
            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-stream_loop", "-1",
                "-i", video_path,
                "-ss", f"{start:.3f}",
                "-vf", f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}",
                "-frames:v", str(frames),
                "-q:v", "3",
                os.path.join(frame_dir, "%06d.jpg"),
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                os.remove(video_path)
            except Exception:
                pass
            count = len([n for n in os.listdir(frame_dir) if n.endswith(".jpg")])
            if count == 0:
                shutil.rmtree(frame_dir, ignore_errors=True)
                err = res.stderr.decode("utf-8", errors="replace")[-400:]
                return self.send_json(500, {"ok": False, "error": f"Background decode failed: {err}"})
            return self.send_json(200, {"ok": True, "prepId": prep_id, "count": count})

        if parsed.path == "/api/bg/cleanup":
            prep_id = qs.get("prepId", [""])[0]
            if prep_id.isalnum():
                shutil.rmtree(os.path.join(EXPORT_DIR, f"bg_{prep_id}"), ignore_errors=True)
            return self.send_json(200, {"ok": True})

        return self.send_json(404, {"ok": False, "error": "Unknown API endpoint"})


if __name__ == "__main__":
    # Clean old temp files on startup
    for fname in os.listdir(EXPORT_DIR):
        fpath = os.path.join(EXPORT_DIR, fname)
        try:
            if os.path.isfile(fpath):
                os.remove(fpath)
            elif os.path.isdir(fpath):
                shutil.rmtree(fpath, ignore_errors=True)
        except Exception:
            pass

    class StudioServer(ThreadingHTTPServer):
        request_queue_size = 256
        daemon_threads = True

    server = StudioServer(("127.0.0.1", PORT), StudioRequestHandler)
    print(f"LyricTok Studio (Python + FFmpeg GPU Server) running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
