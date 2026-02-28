import sys
import os
import webview
import threading
import time
from datetime import datetime

alarm_time=None
alarm_active=False

settings={
    "military":False,
    "theme":"mac",
    "font":"Segoe UI",
    "sound":"alarm1"
}

main_window=None
api=None

def resource_path(relative):

    try:
        base = sys._MEIPASS
    except:
        base = os.path.abspath(".")

    return os.path.join(base, relative)

class API:

    def set_alarm(self,time_value):

        global alarm_time,alarm_active

        alarm_time=time_value
        alarm_active=True

        return "Alarm Set"


    def stop_alarm(self):

        global alarm_active

        alarm_active=False

        main_window.evaluate_js("stopSound()")

        return "Stopped"


    def open_settings(self):

        webview.create_window(
            "Settings",
            resource_path("web/settings.html"),
            js_api=api,
            width=320,
            height=560,
            resizable=False
        )


    def get_settings(self):
        return settings


    def save_settings(self,s):

        global settings

        settings=s

        # Apply instantly
        main_window.evaluate_js(
            f"applyTheme('{s['theme']}')"
        )

        main_window.evaluate_js(
            f"applyFont('{s['font']}')"
        )

        main_window.evaluate_js(
            f"setSound('{s['sound']}')"
        )

        main_window.evaluate_js(
            f"setMilitary({str(s['military']).lower()})"
        )

        return "Saved"



def alarm_loop():

    global alarm_time,alarm_active

    while True:

        if alarm_active and alarm_time:

            now=datetime.now().strftime("%H:%M:%S")

            if now==alarm_time:

                alarm_active=False

                main_window.evaluate_js("playSound()")

        time.sleep(0.5)



api=API()

threading.Thread(
target=alarm_loop,
daemon=True
).start()


main_window=webview.create_window(

"Alarm Clock",
resource_path("web/index.html"),
js_api=api,

width=360,
height=340,

resizable=True,
min_size=(300,380)

)

webview.start()