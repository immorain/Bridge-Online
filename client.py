import requests
import json
import ast

BASE_URL = 'http://127.0.0.1:5000'





def post_name(name):
    user_name = name
    post_ready = {'name': user_name}
    response = requests.post(f"{BASE_URL}/ready", json=post_ready)
    UUID = list(response.json())[0]
    return UUID

def start_game():
    requests.get(f"{BASE_URL}/start")
    requests.get(f"{BASE_URL}/gamestatestart")

def get_hands(UUID):
    response = requests.get(f"{BASE_URL}/gethands/{UUID}")
    text = ast.literal_eval(str(response.text))
    return text


uuid1 = post_name('jackson')
uuid2 = post_name('ian')
uuid3 = post_name('ben')
uuid4 = post_name('bel')

start_game()
hands = get_hands(uuid1)
print(hands)

response =requests.get(f"{BASE_URL}/clear")
