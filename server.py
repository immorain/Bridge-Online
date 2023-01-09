from flask import Flask,jsonify,request
import random
from flask_uuid import FlaskUUID
import uuid
import time

class Card:
    def __init__(self, suit, rank):
        self.suit = suit
        self.rank = rank

    def __str__(self):
        return f'{self.rank} of {self.suit}'

class Deck:
    def __init__(self):
        self.cards = []
        for suit in ['Hearts', 'Diamonds', 'Spades', 'Clubs']:
            for rank in range(1, 14): # rank values start at 2
                self.cards.append(Card(suit, rank))

    def shuffle(self):
        random.shuffle(self.cards)

    def deal(self, num_hands, num_cards):
        if num_cards * num_hands > len(self.cards):
            raise ValueError('Not enough cards in the deck!')
        hands = []
        for i in range(num_hands):
            hand = []
            for j in range(num_cards):
                hand.append(self.cards.pop())
            hands.append(hand)
        return hands

def suit_sort(card):
    return card.suit,card.rank

app = Flask(__name__)
FlaskUUID(app)

@app.after_request
def treat_as_plain_text(response):
    response.headers["content-type"] = "text/plain"
    return response

@app.route('/')
def test():
    return 'NULL'

# @app.route('/drawcards')
# def drawcards():
#     deck = Deck()
#     deck.shuffle()
#     hands = deck.deal(4,13)
#     dic={}
#     for z, i in enumerate(hands):
#         dic[f'Player{z + 1}'] = i
#     showstring=''
#     for i in dic:
#         sorted_hand = sorted(dic[i],key=suit_sort)
#         string = ''
#         for c in sorted_hand:
#             string += f'|{c}|'
#         showstring +=f'{i} hand: {string}\n'
#     return showstring

@app.route('/ready',methods = ['POST'])
def ready():
    global no_players
    random_uuid = uuid.uuid4()
    players_info={}
    players_info[str(random_uuid)] = {'name':request.json['name']}
    no_players[str(random_uuid)] = {'name':request.json['name']}
    print(no_players)
    return jsonify(players_info)

@app.route('/clear')
def clear():
    global no_players
    no_players = {}
    return no_players

@app.route('/checkplayers')
def check():
    return str(len(no_players))

@app.route('/start')
def start():
    deck = Deck()
    deck.shuffle()
    hands = deck.deal(4, 13)
    for y,i in enumerate(no_players):
        no_players[i]['hands'] = hands[y]

    for i in no_players:
        no_players[i]['hands'] = sorted(no_players[i]['hands'],key=suit_sort)

    return 'true'

@app.route('/gethands/<uuid:id>')
def gethand(id):
    hand = []
    for i in no_players[str(id)]['hands']:
        hand.append((str(i.rank),str(i.suit)))

    return hand

# @app.route('/playcard/<uuid:id>',methods = ['POST'])
# def playcard(id):
#     for i in no_players[str(id)]['hands']:
#         if [i.rank,i.suit] == request.json['card']:
#             a = no_players[str(id)]['hands'].pop(i)
#             return (a.rank,a.suit)
#     return 'false'








if __name__ == '__main__':
    global no_players
    no_players = {}
    app.run()