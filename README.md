# Bridge-Online
Create a multiplayer online card game Bridge.


There are 2 programs. client.py and server.py



Server.py runs the server using Flask as an endpoint connection.




client.py is the user endpoint to interact with the server.

Todo:
1. Bidding System
player 1: select a number from 1-7 , clubs/diamonds/hearts/spade or skip
player 2: checks for previous player input. select a number from 1-7 , clubs/diamonds/hearts/spade or skip. if input given by player 2 is greater than player 1 or skip, go to player 3. If not, input again 
player 3: checks for previous player input. select a number from 1-7 , clubs/diamonds/hearts/spade or skip. if input given by player 3 is greater than player 1 or skip, go to player 4. If not, input again 
player 4: checks for previous player input. select a number from 1-7 , clubs/diamonds/hearts/spade or skip. if input given by player 4 is greater than player 3 or skip, go to player 1. If not, input again 

end when theres 3 skips in a row

server: generate a gamestate to determine whos turn it is and what type of turn (bidding/placing cards). each turn has a 10 sec timeout.
