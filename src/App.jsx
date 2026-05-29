import { useState } from "react"

const deck = ["A♠", "2♠", "3♠", "4♠", "5♠", "6♠", "7♠", "8♠", "9♠", "10♠", "J♠", "Q♠", "K♠"]

function drawCard() {
  return deck[Math.floor(Math.random() * deck.length)]
}

function cardValue(card) {
  const rank = card.replace("♠", "")
  if (rank === "A") return 11
  if (["J", "Q", "K"].includes(rank)) return 10
  return Number(rank)
}

function handValue(hand) {
  return hand.reduce((total, card) => total + cardValue(card), 0)
}

function App() {
  const [screen, setScreen] = useState("home")
  const [roomCode, setRoomCode] = useState("")
  const [playerHand, setPlayerHand] = useState(["A♠", "K♠"])
  const [dealerHand, setDealerHand] = useState(["?"])
  const [message, setMessage] = useState("Hit or Stand")

  function createRoom() {
    setRoomCode("GNL123")
    setScreen("games")
  }

  function startBlackjack() {
    setPlayerHand([drawCard(), drawCard()])
    setDealerHand([drawCard()])
    setMessage("Hit or Stand")
    setScreen("blackjack")
  }

  function hit() {
    const newHand = [...playerHand, drawCard()]
    setPlayerHand(newHand)

    if (handValue(newHand) > 21) {
      setMessage("Bust! You lose.")
    }
  }

  function stand() {
    const dealer = [drawCard(), drawCard()]
    setDealerHand(dealer)

    const playerScore = handValue(playerHand)
    const dealerScore = handValue(dealer)

    if (dealerScore > 21 || playerScore > dealerScore) {
      setMessage("You win!")
    } else if (playerScore === dealerScore) {
      setMessage("Push / Tie")
    } else {
      setMessage("Dealer wins.")
    }
  }

  if (screen === "games") {
    return (
      <div style={{ textAlign: "center", paddingTop: "80px" }}>
        <h1>🎮 Choose a Game</h1>
        <p>Room Code: <strong>{roomCode}</strong></p>

        <div style={{ marginTop: "40px" }}>
          <button onClick={startBlackjack}>Blackjack</button>
          <button style={{ marginLeft: "20px" }}>Trivia</button>
          <button style={{ marginLeft: "20px" }}>Sensorium</button>
        </div>
      </div>
    )
  }

  if (screen === "blackjack") {
    return (
      <div style={{ textAlign: "center", paddingTop: "60px" }}>
        <h1>🃏 Blackjack</h1>
        <p>Room Code: {roomCode}</p>

        <h2>Dealer</h2>
        <p>{dealerHand.map(card => `[ ${card} ]`).join(" ")}</p>
        <p>Dealer Score: {dealerHand.includes("?") ? "?" : handValue(dealerHand)}</p>

        <h2>Player</h2>
        <p>{playerHand.map(card => `[ ${card} ]`).join(" ")}</p>
        <p>Player Score: {handValue(playerHand)}</p>

        <h2>{message}</h2>

        <button onClick={hit}>Hit</button>
        <button onClick={stand} style={{ marginLeft: "20px" }}>Stand</button>

        <br /><br />

        <button onClick={() => setScreen("home")}>Back</button>
      </div>
    )
  }

  return (
    <div style={{ textAlign: "center", paddingTop: "100px" }}>
      <h1>🎲 GameNightLab</h1>
      <p>Party Games for Friends and Family</p>

      <div style={{ marginTop: "40px" }}>
        <button onClick={createRoom}>Create Room</button>
        <button style={{ marginLeft: "20px" }}>Join Room</button>
      </div>
    </div>
  )
}

export default App