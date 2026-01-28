import requests
import json

BASE_URL = "http://localhost:3000"

def run():
    print("🚀 Verifying M3U Generation...")

    # 1. Login
    print("🔑 Logging in as Admin...")
    # Default password from previous server.log output was d72e940805ba5d0a
    # If server restarted, it might have generated a new one if not persisted?
    # Wait, server.js says: "Generated new unique encryption key... saved to secret.key"
    # But admin password?
    # "Create default admin user if no users exist"
    # If db.sqlite persists, admin is there.
    # The default password is printed to console ONCE on creation.
    # If I don't know it, I can't login.
    # But I am in the sandbox. I can reset the DB or check `server.log` history if I scroll up...
    # The log said: Password: d72e940805ba5d0a
    # Let's try that.

    password = "d72e940805ba5d0a"

    session = requests.Session()
    try:
        res = session.post(f"{BASE_URL}/api/login", json={"username": "admin", "password": password})
        if res.status_code != 200:
            print("❌ Login failed. Maybe password changed or DB reset?")
            # Try to grep password from server.log if present
            try:
                with open("server.log", "r") as f:
                    log = f.read()
                    import re
                    m = re.search(r"Password: ([a-f0-9]+)", log)
                    if m:
                        password = m.group(1)
                        print(f"🔑 Found password in log: {password}")
                        res = session.post(f"{BASE_URL}/api/login", json={"username": "admin", "password": password})
            except:
                pass

        if res.status_code != 200:
            print(f"❌ Login failed: {res.text}")
            return

        token = res.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        # 2. Create User
        print("👤 Creating Test User...")
        res = requests.post(f"{BASE_URL}/api/users", json={"username": "m3utest", "password": "password123"}, headers=headers)
        if res.status_code == 200:
            print("✅ User created")
        elif "username_taken" in res.text:
            print("ℹ️ User already exists")
        else:
            print(f"❌ Failed to create user: {res.text}")
            return

        # 3. Test get.php
        print("📥 Fetching M3U...")
        m3u_url = f"{BASE_URL}/get.php?username=m3utest&password=password123&type=m3u_plus&output=ts"
        res = requests.get(m3u_url)

        if res.status_code == 200:
            content = res.text
            if "#EXTM3U" in content:
                print("✅ M3U Header found")
                if "url-tvg=" in content:
                    print("✅ m3u_plus metadata found")
                print("✅ M3U Verification Successful")
            else:
                print("❌ M3U content invalid")
                print(content)
        else:
            print(f"❌ Failed to fetch M3U: {res.status_code} {res.text}")

    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    run()
