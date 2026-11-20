"""CI 診斷：ODA 安裝後建立了哪些捷徑、MSI 的 Shortcut 表與功能。"""
import glob
import os

roots = {
    "Public Desktop": os.path.join(os.environ.get("PUBLIC", r"C:\Users\Public"), "Desktop"),
    "User Desktop": os.path.join(os.environ["USERPROFILE"], "Desktop"),
    "All Users Start Menu": os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), r"Microsoft\Windows\Start Menu\Programs"),
    "User Start Menu": os.path.join(os.environ["APPDATA"], r"Microsoft\Windows\Start Menu\Programs"),
}
for name, root in roots.items():
    hits = [p for p in glob.glob(os.path.join(root, "**", "*"), recursive=True) if "oda" in p.lower()]
    print(f"[{name}] {root}")
    for h in hits:
        print("   ", h)

msi = glob.glob(os.path.join(os.environ["TEMP"], "**", "ODAFileConverter*.msi"), recursive=True)
if not msi:
    import urllib.request, re
    from cadapp import oda_setup
    url = oda_setup.find_installer_url()
    path = os.path.join(os.environ["TEMP"], "oda.msi")
    oda_setup.download(url, path)
    msi = [path]
try:
    import msilib
    db = msilib.OpenDatabase(msi[0], msilib.MSIDBOPEN_READONLY)
    for table, q in (("Shortcut", "SELECT Shortcut, Directory_, Name, Component_ FROM Shortcut"),
                     ("Feature", "SELECT Feature, Title, Level FROM Feature"),
                     ("FeatureComponents", "SELECT Feature_, Component_ FROM FeatureComponents"),
                     ("Property", "SELECT Property, Value FROM Property")):
        print(f"== {table}")
        try:
            v = db.OpenView(q)
            v.Execute(None)
            while True:
                r = v.Fetch()
                if r is None:
                    break
                n = r.GetFieldCount()
                print("   ", " | ".join(str(r.GetString(i + 1)) for i in range(n)))
        except Exception as ex:  # noqa: BLE001
            print("    error", ex)
except ImportError:
    print("no msilib")
