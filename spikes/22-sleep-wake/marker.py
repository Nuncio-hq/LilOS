import json
import sys
import time

label, detail, path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "a") as f:
    f.write(json.dumps({"t_wall": time.time(), "t_mono": time.monotonic(),
                        "dir": "marker",
                        "frame": {"label": label, "detail": detail}}) + "\n")
