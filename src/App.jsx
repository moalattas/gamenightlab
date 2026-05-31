import { useCallback, useEffect, useState } from "react"
import { supabase } from "./supabase"

const SESSION_STORAGE_KEY = "gamenightlab-session"
const cardRanks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
const cardSuits = ["♠", "♥", "♦", "♣"]
const deck = cardSuits.flatMap((suit) =>
  cardRanks.map((rank) => `${rank}${suit}`)
)

function shuffleDeck() {
  return [...deck].sort(() => Math.random() - 0.5)
}

function cardValue(card) {
  const rank = String(card).match(/10|[AJQK2-9]/)?.[0]
  if (rank === "A") return 11
  if (["J", "Q", "K"].includes(rank)) return 10
  return Number(rank || 0)
}

function handValue(hand) {
  return hand.reduce((total, card) => total + cardValue(card), 0)
}

function getTurnOrderedPlayers(players) {
  const connectedPlayers = players.filter((player) => player.connected)
  const byCreatedAt = (a, b) => new Date(a.created_at) - new Date(b.created_at)
  const nonHostPlayers = connectedPlayers
    .filter((player) => !player.is_host)
    .sort(byCreatedAt)
  const hostPlayers = connectedPlayers
    .filter((player) => player.is_host)
    .sort(byCreatedAt)

  return [...nonHostPlayers, ...hostPlayers]
}

function App() {
  const [screen, setScreen] = useState("home")
  const [roomCode, setRoomCode] = useState("")
  const [joinCode, setJoinCode] = useState("")
  const [playerName, setPlayerName] = useState("")
  const [players, setPlayers] = useState([])
  const [isHost, setIsHost] = useState(false)
  const [currentPlayerId, setCurrentPlayerId] = useState(null)
  const [gameState, setGameState] = useState(null)
  const [playerHand, setPlayerHand] = useState(["A♠", "K♥"])
  const [dealerHand, setDealerHand] = useState(["?"])
  const [message, setMessage] = useState("Hit or Stand")

  const loadPlayers = useCallback(async (code) => {
    if (!code) return

    const { data, error } = await supabase
      .from("players")
      .select("*")
      .eq("room_code", code)
      .order("created_at", { ascending: true })

    if (error) {
      console.error(error)
      return
    }

    setPlayers(data || [])
  }, [])

  const applyGameState = useCallback((state) => {
    if (!state) return

    setGameState(state)
    setDealerHand(state.dealer_hand || ["?"])
    setMessage(state.message || "Hit or Stand")

    const currentHandKey = currentPlayerId
      ? Object.keys(state.player_hands || {}).find(
          (id) => String(id) === String(currentPlayerId)
        )
      : null

    if (currentHandKey) {
      setPlayerHand(state.player_hands[currentHandKey])
    }
  }, [currentPlayerId])

  const loadGameState = useCallback(async (code) => {
    if (!code) return

    const { data, error } = await supabase
      .from("game_state")
      .select("*")
      .eq("room_code", code)
      .maybeSingle()

    if (error) {
      console.error("Game state load error:", error)
      return
    }

    applyGameState(data)
  }, [applyGameState])

  const advanceTurn = useCallback(async (playerId) => {
    if (!roomCode) return null

    const { data: orderedPlayers, error } = await supabase
      .from("players")
      .select("id, player_name, is_host, connected, created_at")
      .eq("room_code", roomCode)
      .order("created_at", { ascending: true })

    if (error) {
      console.error(error)
      return null
    }

    const activePlayers = getTurnOrderedPlayers(orderedPlayers || [])
    const currentIndex = activePlayers.findIndex(
      (player) => String(player.id) === String(playerId)
    )
    const nextPlayer = currentIndex === -1
      ? null
      : activePlayers[currentIndex + 1] || null
    const isDealerTurn = currentIndex === -1 || currentIndex >= activePlayers.length - 1

    return {
      isDealerTurn,
      nextPlayerId: nextPlayer?.id || null
    }
  }, [roomCode])

  const saveSession = useCallback((session) => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  }, [])

  const leaveSession = useCallback(() => {
    localStorage.removeItem(SESSION_STORAGE_KEY)
    setRoomCode("")
    setCurrentPlayerId(null)
    setPlayerName("")
    setIsHost(false)
    setPlayers([])
    setGameState(null)
    setPlayerHand(["A♠", "K♥"])
    setDealerHand(["?"])
    setMessage("Hit or Stand")
    setScreen("home")
  }, [])

  useEffect(() => {
    const savedSession = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!savedSession) return

    let session

    try {
      session = JSON.parse(savedSession)
    } catch (error) {
      console.error("Saved session parse error:", error)
      localStorage.removeItem(SESSION_STORAGE_KEY)
      return
    }

    if (!session.roomCode || !session.currentPlayerId) {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      return
    }

    let isActive = true

    Promise.resolve().then(async () => {
      if (!isActive) return

      setRoomCode(session.roomCode)
      setCurrentPlayerId(session.currentPlayerId)
      setPlayerName(session.playerName || "")
      setIsHost(Boolean(session.isHost))

      const { data: room, error } = await supabase
        .from("rooms")
        .select("*")
        .eq("room_code", session.roomCode)
        .single()

      if (!isActive) return

      if (error || !room) {
        console.error("Restore room load error:", error)
        leaveSession()
        return
      }

      if (room.status === "playing" && room.game_type === "blackjack") {
        setScreen("blackjack")
      } else {
        setScreen(session.isHost ? "games" : "lobby")
      }
    })

    return () => {
      isActive = false
    }
  }, [leaveSession])

  useEffect(() => {
    if (!roomCode) return

    let isActive = true

    Promise.resolve().then(() => {
      if (isActive) {
        loadPlayers(roomCode)
      }
    })

    const channel = supabase
      .channel(`players-${roomCode}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players"
        },
        (payload) => {
          const changedRoomCode =
            payload.new?.room_code || payload.old?.room_code

          if (changedRoomCode === roomCode && isActive) {
            loadPlayers(roomCode)
          }
        }
      )
      .subscribe((status, error) => {
        if (error) {
          console.error("Players subscription error:", error)
        }

        if (status === "SUBSCRIBED" && isActive) {
          loadPlayers(roomCode)
        }
      })

    return () => {
      isActive = false
      supabase.removeChannel(channel)
    }
  }, [roomCode, loadPlayers])

  useEffect(() => {
    if (!roomCode) return

    let isActive = true

    const handleRoomUpdate = (room) => {
      if (!room || room.room_code !== roomCode || !isActive) return

      if (room.status === "playing" && room.game_type === "blackjack") {
        setScreen("blackjack")
      }
    }

    Promise.resolve().then(async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .eq("room_code", roomCode)
        .single()

      if (error) {
        console.error("Room load error:", error)
        return
      }

      handleRoomUpdate(data)
    })

    const channel = supabase
      .channel(`rooms-${roomCode}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms"
        },
        (payload) => {
          handleRoomUpdate(payload.new)
        }
      )
      .subscribe((status, error) => {
        if (error) {
          console.error("Rooms subscription error:", error)
        }
      })

    return () => {
      isActive = false
      supabase.removeChannel(channel)
    }
  }, [roomCode])

  useEffect(() => {
    if (!roomCode) return

    let isActive = true

    Promise.resolve().then(() => {
      if (isActive) {
        loadGameState(roomCode)
      }
    })

    const channel = supabase
      .channel(`game-state-${roomCode}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "game_state"
        },
        (payload) => {
          const changedRoomCode =
            payload.new?.room_code || payload.old?.room_code

          if (changedRoomCode === roomCode && isActive) {
            applyGameState(payload.new)
          }
        }
      )
      .subscribe((status, error) => {
        if (error) {
          console.error("Game state subscription error:", error)
        }

        if (status === "SUBSCRIBED" && isActive) {
          loadGameState(roomCode)
        }
      })

    return () => {
      isActive = false
      supabase.removeChannel(channel)
    }
  }, [roomCode, loadGameState, applyGameState])

  useEffect(() => {
    if (!gameState || gameState.status !== "dealer_turn" || !isHost || !roomCode) return

    let isActive = true

    Promise.resolve().then(async () => {
      if (!isActive) return

      const nextDeck = [...(gameState.deck || [])]
      const nextDealerHand = [...(gameState.dealer_hand || [])]

      while (handValue(nextDealerHand) < 17 && nextDeck.length > 0) {
        nextDealerHand.push(nextDeck.shift())
      }

      const dealerScore = handValue(nextDealerHand)
      const dealerBust = dealerScore > 21
      const playerHands = gameState.player_hands || {}
      const resultLines = getTurnOrderedPlayers(players).map((player) => {
        const handKey = Object.keys(playerHands).find(
          (id) => String(id) === String(player.id)
        )
        const hand = handKey ? playerHands[handKey] : []
        const playerScore = handValue(hand)
        let result = "Lose"

        if (playerScore > 21) {
          result = "Bust"
        } else if (dealerBust || playerScore > dealerScore) {
          result = "Win"
        } else if (playerScore === dealerScore) {
          result = "Push"
        }

        return `${player.player_name}: ${result}`
      })
      const resultsMessage = `Dealer: ${dealerScore}${dealerBust ? " Bust" : ""}\n${resultLines.join("\n")}`

      const { error } = await supabase
        .from("game_state")
        .update({
          status: "finished",
          dealer_hand: nextDealerHand,
          deck: nextDeck,
          message: resultsMessage,
          updated_at: new Date().toISOString()
        })
        .eq("room_code", roomCode)
        .eq("status", "dealer_turn")

      if (error) {
        console.error(error)
        alert(error.message)
      }
    })

    return () => {
      isActive = false
    }
  }, [gameState, isHost, players, roomCode])

  const currentTurnPlayer = players.find(
    (player) => String(player.id) === String(gameState?.current_turn_player_id)
  )
  const turnOrderedPlayers = getTurnOrderedPlayers(players)
  const waitingForPlayer = turnOrderedPlayers.find(
    (player) => String(player.id) === String(gameState?.current_turn_player_id)
  )
  const isCurrentTurn =
    String(currentPlayerId) === String(gameState?.current_turn_player_id)
  const turnMessage = gameState?.status === "dealer_turn"
    ? "Dealer Turn"
    : isCurrentTurn
      ? "Your Turn"
      : `Waiting for ${waitingForPlayer?.player_name || currentTurnPlayer?.player_name || "player"}`
  const dealerScore = dealerHand.includes("?") ? "?" : handValue(dealerHand)
  const isRoundFinished = gameState?.status === "finished"

  const getPlayerHand = (playerId) => {
    const hands = gameState?.player_hands || {}
    const handKey = Object.keys(hands).find(
      (id) => String(id) === String(playerId)
    )

    return handKey ? hands[handKey] : []
  }

  const getPlayerResult = (player) => {
    if (!isRoundFinished) return null

    return message
      .split("\n")
      .find((line) => line.startsWith(`${player.player_name}:`))
      ?.replace(`${player.player_name}: `, "")
  }

  const getPlayerStatus = (player) => {
    const hand = getPlayerHand(player.id)
    const score = handValue(hand)
    const result = getPlayerResult(player)

    if (result) return result
    if (isRoundFinished) return "Finished"
    if (score > 21) return "Bust"
    if (gameState?.status === "dealer_turn") return "Dealer Turn"
    if (String(player.id) === String(gameState?.current_turn_player_id)) return "Current Turn"
    return "Waiting"
  }

  const createRoom = async () => {
    const newRoomCode =
      Math.random().toString(36).substring(2, 8).toUpperCase()

    const { error: roomError } = await supabase
      .from("rooms")
      .insert([
        {
          room_code: newRoomCode,
          game_type: "blackjack",
          status: "waiting"
        }
      ])

    if (roomError) {
      console.error(roomError)
      alert(roomError.message)
      return
    }

    const { data: player, error: playerError } = await supabase
      .from("players")
      .insert([
        {
          room_code: newRoomCode,
          player_name: "Host",
          is_host: true,
          connected: true
        }
      ])
      .select("id")
      .single()

    if (playerError) {
      console.error(playerError)
      alert(playerError.message)
      return
    }

    saveSession({
      roomCode: newRoomCode,
      currentPlayerId: player.id,
      playerName: "Host",
      isHost: true
    })
    setIsHost(true)
    setCurrentPlayerId(player.id)
    setPlayerName("Host")
    setRoomCode(newRoomCode)
    setScreen("games")
  }

  const joinRoom = async () => {
    if (!joinCode || !playerName) {
      alert("Please enter room code and player name")
      return
    }

    const cleanCode = joinCode.toUpperCase().trim()

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("*")
      .eq("room_code", cleanCode)
      .single()

    if (roomError || !room) {
      alert("Room not found")
      return
    }

    const { data: roomPlayers, error: playersError } = await supabase
      .from("players")
      .select("id, connected")
      .eq("room_code", cleanCode)
      .eq("connected", true)

    if (playersError) {
      console.error(playersError)
      alert(playersError.message)
      return
    }

    if ((roomPlayers || []).length >= 8) {
      alert("This room already has 8 connected players.")
      return
    }

    const { data: player, error: playerError } = await supabase
      .from("players")
      .insert([
        {
          room_code: cleanCode,
          player_name: playerName.trim(),
          is_host: false,
          connected: true
        }
      ])
      .select("id")
      .single()

    if (playerError) {
      console.error(playerError)
      alert(playerError.message)
      return
    }

    saveSession({
      roomCode: cleanCode,
      currentPlayerId: player.id,
      playerName: playerName.trim(),
      isHost: false
    })
    setIsHost(false)
    setCurrentPlayerId(player.id)
    setRoomCode(cleanCode)
    setScreen("lobby")
  }

  const startBlackjackForRoom = async () => {
    if (!roomCode) return

    const { data: roomPlayers, error: playersError } = await supabase
      .from("players")
      .select("id, is_host, connected, created_at")
      .eq("room_code", roomCode)
      .order("created_at", { ascending: true })

    if (playersError) {
      console.error(playersError)
      alert(playersError.message)
      return
    }

    const sharedDeck = shuffleDeck()
    const dealerHand = [sharedDeck.shift()]
    const playerHands = {}
    const turnOrderedPlayers = getTurnOrderedPlayers(roomPlayers || [])
    const firstTurnPlayer = turnOrderedPlayers[0]

    roomPlayers.forEach((player) => {
      playerHands[player.id] = [sharedDeck.shift(), sharedDeck.shift()]
    })

    const nextGameState = {
      room_code: roomCode,
      game_type: "blackjack",
      status: "playing",
      dealer_hand: dealerHand,
      player_hands: playerHands,
      current_turn_player_id: firstTurnPlayer?.id || null,
      deck: sharedDeck,
      message: "Hit or Stand"
    }

    const { data: existingGameState, error: existingGameStateError } =
      await supabase
        .from("game_state")
        .select("id")
        .eq("room_code", roomCode)
        .maybeSingle()

    if (existingGameStateError) {
      console.error(existingGameStateError)
      alert(existingGameStateError.message)
      return
    }

    const gameStateRequest = existingGameState
      ? supabase
          .from("game_state")
          .update(nextGameState)
          .eq("id", existingGameState.id)
      : supabase
          .from("game_state")
          .insert([nextGameState])

    const { error: gameStateError } = await gameStateRequest

    if (gameStateError) {
      console.error(gameStateError)
      alert(gameStateError.message)
      return
    }

    const { error } = await supabase
      .from("rooms")
      .update({
        status: "playing",
        game_type: "blackjack"
      })
      .eq("room_code", roomCode)

    if (error) {
      console.error(error)
      alert(error.message)
    }
  }

  async function hit() {
    if (!gameState || !currentPlayerId || !isCurrentTurn) return

    const sharedDeck = [...(gameState.deck || [])]
    const card = sharedDeck.shift()

    if (!card) return

    const currentHands = gameState.player_hands || {}
    const currentHandKey = Object.keys(currentHands).find(
      (id) => String(id) === String(currentPlayerId)
    ) || currentPlayerId
    const currentHand = currentHands[currentHandKey] || []
    const nextHand = [...currentHand, card]
    const nextPlayerHands = {
      ...currentHands,
      [currentHandKey]: nextHand
    }
    const isBust = handValue(nextHand) > 21
    const turnAdvance = isBust
      ? await advanceTurn(currentPlayerId)
      : null
    const nextTurnPlayerId = isBust
      ? turnAdvance?.nextPlayerId || null
      : gameState.current_turn_player_id
    const isDealerTurn = isBust && Boolean(turnAdvance?.isDealerTurn)
    const nextMessage = isBust ? "Bust!" : "Hit or Stand"

    const { error } = await supabase
      .from("game_state")
      .update({
        status: isDealerTurn ? "dealer_turn" : gameState.status,
        deck: sharedDeck,
        player_hands: nextPlayerHands,
        current_turn_player_id: isDealerTurn ? null : nextTurnPlayerId,
        message: nextMessage,
        updated_at: new Date().toISOString()
      })
      .eq("room_code", roomCode)

    if (error) {
      console.error(error)
      alert(error.message)
    }
  }

  async function stand() {
    const standIsCurrentTurn =
      String(currentPlayerId) === String(gameState?.current_turn_player_id)

    if (!gameState || !currentPlayerId || !standIsCurrentTurn) {
      return
    }

    const standingPlayerId = currentPlayerId
    const turnAdvance = await advanceTurn(standingPlayerId)
    const nextTurnPlayerId = turnAdvance?.nextPlayerId || null
    const isDealerTurn = Boolean(turnAdvance?.isDealerTurn)
    const standUpdatePayload = {
      status: isDealerTurn ? "dealer_turn" : gameState.status,
      current_turn_player_id: isDealerTurn ? null : nextTurnPlayerId,
      message: isDealerTurn ? "Dealer Turn" : "Hit or Stand",
      updated_at: new Date().toISOString()
    }

    const { error } = await supabase
      .from("game_state")
      .update(standUpdatePayload)
      .eq("room_code", roomCode)
      .select("*")
      .single()

    if (error) {
      console.error(error)
      alert(error.message)
    }
  }

  const casinoStyles = {
    page: {
      minHeight: "100vh",
      overflow: "hidden",
      background: "radial-gradient(circle at top, #4a1014 0%, #22070a 54%, #120305 100%)",
      color: "#fff8dc",
      fontFamily: "Arial, Helvetica, sans-serif"
    },
    tableShell: {
      padding: "18px 36px 56px",
      maxWidth: "1680px",
      margin: "0 auto"
    },
    tableHeader: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "20px",
      marginBottom: "12px"
    },
    table: {
      position: "relative",
      minHeight: "782px",
      width: "100%",
      borderRadius: "48% 48% 42% 42%",
      border: "18px solid #9b6325",
      background: "radial-gradient(circle at 50% 42%, #20a094 0%, #0c786c 45%, #03483f 100%)",
      boxShadow: "0 28px 80px rgba(0, 0, 0, 0.45), inset 0 0 0 6px rgba(251, 216, 104, 0.72), inset 0 0 0 12px rgba(71, 31, 13, 0.38), inset 0 0 90px rgba(0, 0, 0, 0.42)",
      overflow: "hidden"
    },
    dealerArea: {
      position: "absolute",
      top: "96px",
      left: "50%",
      transform: "translateX(-50%)",
      width: "390px",
      textAlign: "center",
      padding: "12px 18px 16px",
      borderRadius: "22px",
      background: "transparent"
    },
    dealerRail: {
      position: "absolute",
      top: "14px",
      left: "50%",
      transform: "translateX(-50%)",
      width: "610px",
      height: "78px",
      borderRadius: "12px",
      border: "4px solid rgba(244, 209, 106, 0.88)",
      background: "linear-gradient(180deg, rgba(250, 218, 125, 0.28) 0%, rgba(43, 23, 12, 0.48) 100%)",
      boxShadow: "0 16px 32px rgba(0, 0, 0, 0.36), inset 0 0 0 2px rgba(255, 248, 220, 0.18), inset 0 -12px 18px rgba(0, 0, 0, 0.2)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      gap: "10px"
    },
    chipStack: {
      width: "38px",
      height: "48px",
      borderRadius: "999px",
      border: "3px dashed rgba(255, 255, 255, 0.92)",
      boxShadow: "0 5px 10px rgba(0, 0, 0, 0.28), inset 0 0 0 5px rgba(255, 255, 255, 0.18)",
      color: "#fff",
      fontSize: "11px",
      fontWeight: "900",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textShadow: "0 1px 3px rgba(0, 0, 0, 0.7)"
    },
    deck: {
      position: "absolute",
      top: "132px",
      left: "58%",
      width: "78px",
      height: "108px",
      background: "transparent",
      transform: "rotate(0deg)",
      animation: "deckPulse 1400ms ease-in-out infinite"
    },
    deckCardTop: {
      position: "absolute",
      width: "62px",
      height: "92px",
      boxSizing: "border-box",
      borderRadius: "11px",
      border: "5px solid #d8d0c8",
      backgroundColor: "#fffaf4",
      backgroundImage: "linear-gradient(45deg, transparent 42%, #e85f65 43%, #e85f65 50%, transparent 51%), linear-gradient(-45deg, transparent 42%, #e85f65 43%, #e85f65 50%, transparent 51%)",
      backgroundSize: "11px 11px",
      backgroundPosition: "8px 8px",
      boxShadow: "0 7px 14px rgba(0, 0, 0, 0.24), inset 0 0 0 7px #fffaf4, inset 0 0 0 9px rgba(232, 95, 101, 0.76)"
    },
    centerPanel: {
      position: "absolute",
      top: "52%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "390px",
      textAlign: "center",
      padding: "20px 24px",
      borderRadius: "999px",
      border: "1px solid rgba(244, 209, 106, 0.5)",
      background: "rgba(4, 44, 38, 0.5)",
      boxShadow: "0 18px 42px rgba(0, 0, 0, 0.22), inset 0 0 20px rgba(255, 248, 220, 0.06)"
    },
    seat: {
      position: "absolute",
      width: "226px",
      minHeight: "142px",
      padding: "8px 8px 12px",
      borderRadius: "28px",
      border: "1px solid transparent",
      background: "transparent",
      textAlign: "center",
      transition: "box-shadow 220ms ease, border-color 220ms ease, background 220ms ease"
    },
    currentSeat: {
      border: "1px solid transparent",
      background: "transparent",
      boxShadow: "0 0 28px rgba(255, 226, 122, 0.82)",
      animation: "turnGlow 1600ms ease-in-out infinite"
    },
    openSeat: {
      width: "138px",
      minHeight: "72px",
      padding: "8px",
      border: "2px dashed rgba(244, 209, 106, 0.24)",
      background: "rgba(255, 248, 220, 0.03)",
      color: "rgba(255, 248, 220, 0.48)"
    },
    cardRow: {
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      height: "72px",
      margin: "8px auto",
      position: "relative"
    },
    tableHandZone: {
      width: "232px",
      height: "112px",
      margin: "6px auto 0"
    },
    dealerHandZone: {
      width: "318px",
      height: "126px",
      margin: "4px auto 0"
    },
    phoneHandZone: {
      width: "100%",
      minHeight: "76px",
      margin: "10px auto",
      flexWrap: "wrap",
      gap: "6px"
    },
    card: {
      display: "inline-block",
      width: "62px",
      height: "92px",
      boxSizing: "border-box",
      borderRadius: "11px",
      border: "5px solid #050505",
      background: "#fff",
      color: "#161211",
      fontWeight: "800",
      lineHeight: 1,
      boxShadow: "0 7px 14px rgba(0, 0, 0, 0.28)",
      position: "relative",
      overflow: "hidden",
      transition: "transform 220ms ease, margin-left 220ms ease, box-shadow 220ms ease"
    },
    cardBack: {
      border: "5px solid #c7c0ba",
      backgroundColor: "#fffaf4",
      backgroundImage: "linear-gradient(45deg, transparent 42%, #e85f65 43%, #e85f65 50%, transparent 51%), linear-gradient(-45deg, transparent 42%, #e85f65 43%, #e85f65 50%, transparent 51%)",
      backgroundSize: "11px 11px",
      backgroundPosition: "8px 8px",
      boxShadow: "0 7px 14px rgba(0, 0, 0, 0.28), inset 0 0 0 7px #fffaf4, inset 0 0 0 9px rgba(232, 95, 101, 0.72)"
    },
    dealerCard: {
      width: "62px",
      height: "92px",
      borderRadius: "11px",
      border: "5px solid #050505"
    },
    phoneCard: {
      width: "52px",
      height: "76px",
      border: "4px solid #050505",
      borderRadius: "10px",
      position: "static"
    },
    cardCorner: {
      position: "absolute",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "2px",
      fontSize: "15px",
      fontWeight: "900",
      lineHeight: 0.78
    },
    cardCenterSuit: {
      position: "absolute",
      top: "58%",
      left: "47%",
      transform: "translate(-50%, -50%) scaleX(1.04)",
      fontSize: "44px",
      fontWeight: "900",
      lineHeight: 1
    },
    badge: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "26px",
      minWidth: "34px",
      padding: "4px 10px",
      borderRadius: "999px",
      background: "linear-gradient(145deg, #f4d16a 0%, #7a511c 100%)",
      color: "#16090a",
      border: "2px solid rgba(17, 10, 12, 0.9)",
      boxShadow: "0 3px 8px rgba(0, 0, 0, 0.28), inset 0 0 0 1px rgba(255, 248, 220, 0.35)",
      fontSize: "14px",
      fontWeight: "800"
    },
    resultBadge: {
      background: "#f4d16a",
      color: "#2a080b",
      animation: "resultPop 300ms ease-out both"
    },
    handBadgeRow: {
      position: "absolute",
      left: "6px",
      right: "6px",
      bottom: "-4px",
      display: "flex",
      justifyContent: "space-between",
      pointerEvents: "none",
      zIndex: 20
    },
    goldButton: {
      padding: "12px 18px",
      border: "0",
      borderRadius: "999px",
      background: "#f4d16a",
      color: "#2a080b",
      fontWeight: "800",
      fontSize: "16px",
      cursor: "pointer"
    },
    phonePage: {
      minHeight: "100vh",
      textAlign: "center",
      padding: "40px 20px",
      background: "linear-gradient(180deg, #3a0b10 0%, #160406 100%)",
      color: "#fff8dc",
      fontFamily: "Arial, Helvetica, sans-serif"
    },
    phonePanel: {
      maxWidth: "440px",
      margin: "0 auto",
      padding: "24px",
      borderRadius: "28px",
      border: "3px solid #d7a83b",
      background: "#0a5a50"
    }
  }

  const seatPositions = [
    { top: "22%", left: "9%" },
    { top: "22%", right: "9%" },
    { top: "52%", left: "5%" },
    { top: "52%", right: "5%" },
    { bottom: "14%", left: "9%" },
    { bottom: "8%", left: "31%" },
    { bottom: "8%", right: "31%" },
    { bottom: "14%", right: "9%" }
  ]

  const casinoKeyframes = `
    @keyframes cardDealIn {
      0% {
        opacity: 0;
        transform: translateY(-20px) scale(0.8);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @keyframes resultPop {
      0% {
        opacity: 0;
        transform: scale(0.82);
      }
      100% {
        opacity: 1;
        transform: scale(1);
      }
    }

    @keyframes turnGlow {
      0%, 100% {
        box-shadow: 0 0 18px rgba(255, 226, 122, 0.5);
      }
      50% {
        box-shadow: 0 0 32px rgba(255, 226, 122, 0.88);
      }
    }

    @keyframes deckPulse {
      0%, 100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(-1px);
      }
    }
  `

  const getCardParts = (card) => {
    const cardText = String(card)
    if (cardText === "?") {
      return { rank: "?", suit: "", isRed: false }
    }

    const rank = cardText.match(/10|[AJQK2-9]/)?.[0] || cardText
    const suit = cardText.includes("\u2665") || cardText.includes("â™¥")
      ? "\u2665"
      : cardText.includes("\u2666") || cardText.includes("â™¦")
        ? "\u2666"
        : cardText.includes("\u2663") || cardText.includes("â™£")
          ? "\u2663"
          : "\u2660"
    const isRed = suit === "\u2665" || suit === "\u2666"

    return { rank, suit, isRed }
  }

  const renderCards = (cards, variant = "phone") => {
    const isPhone = variant === "phone"
    const isDealer = variant === "dealer"
    const handZoneStyle = isDealer
      ? casinoStyles.dealerHandZone
      : isPhone
        ? casinoStyles.phoneHandZone
        : casinoStyles.tableHandZone

    return (
      <div style={{ ...casinoStyles.cardRow, ...handZoneStyle }}>
      {cards.length > 0 ? (
        cards.map((card, index) => {
          const { rank, suit, isRed } = getCardParts(card)
          const isCardBack = String(card) === "?"
          const fanOffset = index - (cards.length - 1) / 2
          const cardStyle = {
            ...casinoStyles.card,
            ...(isDealer ? casinoStyles.dealerCard : {}),
            ...(isPhone ? casinoStyles.phoneCard : {}),
            ...(isCardBack ? casinoStyles.cardBack : {}),
            color: isRed ? "#b3131b" : "#171717",
            marginLeft: !isPhone && index > 0 ? "-14px" : 0,
            rotate: !isPhone ? `${fanOffset * 3}deg` : "0deg",
            translate: !isPhone ? `0 ${Math.abs(fanOffset) * 1.5}px` : "0 0",
            zIndex: index + 1,
            animation: "cardDealIn 320ms ease-out both",
            animationDelay: `${index * (isDealer ? 120 : 70)}ms`
          }

          return (
            <span key={`${card}-${index}`} style={cardStyle}>
              {!isCardBack && (
                <>
                  <span
                    style={{
                      ...casinoStyles.cardCorner,
                      top: isDealer ? "7px" : isPhone ? "4px" : "5px",
                      left: isDealer ? "8px" : isPhone ? "5px" : "6px",
                      fontSize: isPhone ? "13px" : "18px"
                    }}
                  >
                    <span style={{ letterSpacing: "-1px" }}>{rank}</span>
                    <span style={{ fontSize: isPhone ? "12px" : "15px" }}>
                      {suit}
                    </span>
                  </span>
                  <span
                    style={{
                      ...casinoStyles.cardCenterSuit,
                      top: "50%",
                      left: "50%",
                      fontSize: isPhone ? "30px" : "48px"
                    }}
                  >
                    {suit}
                  </span>
                  <span
                    style={{
                      ...casinoStyles.cardCorner,
                      right: isDealer ? "5px" : isPhone ? "2px" : "3px",
                      bottom: isDealer ? "5px" : isPhone ? "2px" : "3px",
                      fontSize: isPhone ? "13px" : "18px",
                      transform: "rotate(180deg)"
                    }}
                  >
                    <span style={{ letterSpacing: "-1px" }}>{rank}</span>
                    <span style={{ fontSize: isPhone ? "12px" : "15px" }}>
                      {suit}
                    </span>
                  </span>
                </>
              )}
          </span>
          )
        })
      ) : (
        <span>No cards</span>
      )}
    </div>
    )
  }

  const tablePlayers = getTurnOrderedPlayers(players).slice(0, 8)
  const tableSeats = Array.from({ length: 8 }, (_, index) => tablePlayers[index] || null)
  const dealerChips = [
    { label: "1", color: "#f7f7f7", text: "#143b7a" },
    { label: "5", color: "#b01626", text: "#fff" },
    { label: "10", color: "#244ca8", text: "#fff" },
    { label: "25", color: "#188450", text: "#fff" },
    { label: "50", color: "#7b2cbf", text: "#fff" },
    { label: "100", color: "#111", text: "#f4d16a" },
    { label: "500", color: "#d86f22", text: "#fff" }
  ]

  const getResultBadgeStyle = (status) => {
    if (status === "Win") {
      return {
        ...casinoStyles.badge,
        ...casinoStyles.resultBadge,
        background: "linear-gradient(135deg, #2bb673 0%, #f4d16a 100%)"
      }
    }

    if (status === "Lose") {
      return {
        ...casinoStyles.badge,
        ...casinoStyles.resultBadge,
        background: "#8f1720",
        color: "#fff8dc"
      }
    }

    if (status === "Bust") {
      return {
        ...casinoStyles.badge,
        ...casinoStyles.resultBadge,
        background: "#2a080b",
        color: "#ffb6a8",
        border: "1px solid rgba(255, 117, 94, 0.7)"
      }
    }

    if (status === "Push") {
      return {
        ...casinoStyles.badge,
        ...casinoStyles.resultBadge,
        background: "#d6a33a",
        color: "#2a080b"
      }
    }

    return { ...casinoStyles.badge, ...casinoStyles.resultBadge }
  }

  const PlayerSeat = ({ player, seatIndex }) => {
    const position = seatPositions[seatIndex]

    if (!player) {
      return (
        <div style={{ ...casinoStyles.seat, ...casinoStyles.openSeat, ...position }}>
          <h3 style={{ margin: "18px 0 0", fontSize: "18px", fontWeight: "700" }}>
            Open Seat
          </h3>
        </div>
      )
    }

    const hand = getPlayerHand(player.id)
    const score = handValue(hand)
    const status = getPlayerStatus(player)
    const isSeatTurn =
      String(player.id) === String(gameState?.current_turn_player_id)
    const seatStyle = {
      ...casinoStyles.seat,
      ...(isSeatTurn ? casinoStyles.currentSeat : {}),
      ...position
    }

    return (
      <div style={seatStyle}>
        <h3
          style={{
            margin: "0 0 4px",
            fontSize: "22px",
            color: "#fff8dc",
            textShadow: "0 0 6px rgba(255, 226, 122, 0.95), 0 0 14px rgba(255, 226, 122, 0.72), 0 3px 6px rgba(0, 0, 0, 0.72)"
          }}
        >
          {player.is_host ? "Host: " : ""}
          {player.player_name}
        </h3>
        <div style={{ position: "relative", width: "210px", margin: "0 auto" }}>
          {renderCards(hand, "table")}
          <div style={casinoStyles.handBadgeRow}>
            <span style={casinoStyles.badge}>{score}</span>
            <span style={getResultBadgeStyle(status)}>
              {status}
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (screen === "join") {
    return (
      <div style={{ textAlign: "center", paddingTop: "100px" }}>
        <h1>🚪 Join Room</h1>

        <input
          placeholder="Room Code"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          style={{ padding: "10px", fontSize: "18px", marginBottom: "15px" }}
        />

        <br />

        <input
          placeholder="Your Name"
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
          style={{ padding: "10px", fontSize: "18px", marginBottom: "20px" }}
        />

        <br />

        <button onClick={joinRoom}>Join</button>
        <button onClick={() => setScreen("home")} style={{ marginLeft: "20px" }}>
          Back
        </button>
      </div>
    )
  }

  if (screen === "lobby") {
    return (
      <div style={{ textAlign: "center", paddingTop: "80px" }}>
        <h1>🎮 Lobby</h1>

        <p>
          Room Code: <strong>{roomCode}</strong>
        </p>

        <h2>Connected Players</h2>

        {players.map((player) => (
          <div key={player.id}>
            {player.is_host ? "👑 " : "👤 "}
            {player.player_name}
          </div>
        ))}

        <br />

        <h3>Waiting for host to start...</h3>

        <button onClick={leaveSession}>
          Leave Lobby
        </button>
      </div>
    )
  }

  if (screen === "games") {
    return (
      <div style={{ textAlign: "center", paddingTop: "80px" }}>
        <h1>🎮 Choose a Game</h1>

        <p>
          Room Code: <strong>{roomCode}</strong>
        </p>

        <h2>Connected Players</h2>

        {players.map((player) => (
          <div key={player.id}>
            {player.is_host ? "👑 " : "👤 "}
            {player.player_name}
          </div>
        ))}

        <div style={{ marginTop: "40px" }}>
          {isHost && (
            <button onClick={startBlackjackForRoom}>Start Blackjack</button>
          )}
          <button style={{ marginLeft: "20px" }}>Trivia</button>
          <button style={{ marginLeft: "20px" }}>Sensorium</button>
        </div>
      </div>
    )
  }

  if (screen === "blackjack" && isHost) {
    return (
      <div style={casinoStyles.page}>
        <style>{casinoKeyframes}</style>
        <div style={casinoStyles.tableShell}>
          <div style={casinoStyles.tableHeader}>
            <div>
              <h1 style={{ margin: 0, fontSize: "44px", letterSpacing: 0 }}>
                Blackjack Table
              </h1>
              <p style={{ margin: "8px 0 0", fontSize: "22px" }}>
                Room Code: <strong>{roomCode}</strong>
              </p>
            </div>

            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
              {isRoundFinished && (
                <button style={casinoStyles.goldButton} onClick={startBlackjackForRoom}>
                  Play Again
                </button>
              )}
              <button style={casinoStyles.goldButton} onClick={leaveSession}>
                Back
              </button>
            </div>
          </div>

          <div style={casinoStyles.table}>
            <div aria-label="Dealer chips" style={casinoStyles.dealerRail}>
              {dealerChips.map((chip) => (
                <div
                  key={chip.label}
                  style={{
                    ...casinoStyles.chipStack,
                    background: chip.color,
                    color: chip.text
                  }}
                >
                  {chip.label}
                </div>
              ))}
            </div>

            <section style={casinoStyles.dealerArea}>
              {renderCards(dealerHand, "dealer")}
              <p style={{ ...casinoStyles.badge, margin: "2px 0 0", fontSize: "16px" }}>
                {dealerScore}
              </p>
            </section>

            <div aria-label="Deck stack" title="Deck stack" style={casinoStyles.deck}>
              {[0, 1, 2, 3].map((cardOffset) => (
                <div
                  key={cardOffset}
                  style={{
                    ...casinoStyles.deckCardTop,
                    top: `${cardOffset * 3}px`,
                    left: `${cardOffset * 3}px`,
                    zIndex: cardOffset + 1
                  }}
                />
              ))}
            </div>

            <section style={casinoStyles.centerPanel}>
              <h2 style={{ margin: "0 0 8px", fontSize: "30px" }}>
                {isRoundFinished ? "Round Results" : "Current Turn"}
              </h2>
              <p style={{ margin: "0 0 12px", fontSize: "24px", fontWeight: "800", color: "#ffe27a" }}>
                {isRoundFinished ? "Finished" : turnMessage}
              </p>
              <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "18px", lineHeight: 1.35 }}>
                {isRoundFinished ? message : gameState?.status === "dealer_turn" ? "Dealer is drawing..." : "Round in progress"}
              </p>

              {isCurrentTurn && !isRoundFinished && gameState?.status !== "dealer_turn" && (
                <div style={{ marginTop: "18px" }}>
                  <button style={casinoStyles.goldButton} onClick={hit}>
                    Hit
                  </button>
                  <button
                    style={{ ...casinoStyles.goldButton, marginLeft: "12px" }}
                    onClick={stand}
                  >
                    Stand
                  </button>
                </div>
              )}
            </section>

            {tableSeats.map((player, index) => (
              <PlayerSeat
                key={player ? player.id : `open-seat-${index}`}
                player={player}
                seatIndex={index}
              />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (screen === "blackjack") {
    const playerResult = getPlayerResult({ id: currentPlayerId, player_name: playerName })

    return (
      <div style={casinoStyles.phonePage}>
        <style>{casinoKeyframes}</style>
        <div style={casinoStyles.phonePanel}>
          <h1 style={{ marginTop: 0, fontSize: "34px" }}>Blackjack</h1>
          <p>
            Room Code: <strong>{roomCode}</strong>
          </p>

          <h2>Your Hand</h2>
          {renderCards(playerHand, "phone")}
          <p style={{ fontSize: "24px", fontWeight: "800" }}>
            Score: {handValue(playerHand)}
          </p>

          <h2 style={{ color: "#ffe27a" }}>
            {isRoundFinished ? "Finished" : turnMessage}
          </h2>

          {!isCurrentTurn && !isRoundFinished && gameState?.status !== "dealer_turn" && (
            <p>
              Waiting for {waitingForPlayer?.player_name || currentTurnPlayer?.player_name || "the next player"}
            </p>
          )}

          {gameState?.status === "dealer_turn" && !isRoundFinished && (
            <p>Dealer Turn</p>
          )}

          {isRoundFinished ? (
            <div>
              <h2>Result</h2>
              {playerResult ? (
                <p style={{ ...getResultBadgeStyle(playerResult), fontSize: "20px" }}>
                  {playerResult}
                </p>
              ) : (
                <p style={{ whiteSpace: "pre-wrap", fontSize: "20px" }}>
                  {message}
                </p>
              )}
            </div>
          ) : (
            <div>
              <button
                style={{
                  ...casinoStyles.goldButton,
                  opacity: isCurrentTurn ? 1 : 0.45,
                  cursor: isCurrentTurn ? "pointer" : "not-allowed",
                  fontSize: "18px",
                  padding: "14px 24px"
                }}
                onClick={hit}
                disabled={!isCurrentTurn}
              >
                Hit
              </button>
              <button
                style={{
                  ...casinoStyles.goldButton,
                  marginLeft: "14px",
                  opacity: isCurrentTurn ? 1 : 0.45,
                  cursor: isCurrentTurn ? "pointer" : "not-allowed",
                  fontSize: "18px",
                  padding: "14px 24px"
                }}
                onClick={stand}
                disabled={!isCurrentTurn}
              >
                Stand
              </button>
            </div>
          )}

          <br /><br />

          <button style={casinoStyles.goldButton} onClick={leaveSession}>
            Back
          </button>
        </div>
      </div>
    )
  }

  if (screen === "unused-blackjack") {
    if (isHost) {
      return (
        <div style={{ padding: "40px", maxWidth: "1100px", margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h1>🃏 Blackjack Table</h1>
              <p>Room Code: <strong>{roomCode}</strong></p>
            </div>

            {isRoundFinished && (
              <button onClick={startBlackjackForRoom}>Play Again</button>
            )}
          </div>

          <section style={{ textAlign: "center", marginTop: "30px", padding: "24px", border: "1px solid #ddd" }}>
            <h2>Dealer</h2>
            <p style={{ fontSize: "28px" }}>{dealerHand.map(card => `[ ${card} ]`).join(" ")}</p>
            <p>Score: {dealerScore}</p>
          </section>

          <section style={{ marginTop: "30px" }}>
            <h2>Current Turn</h2>
            <p style={{ fontSize: "22px" }}>{turnMessage}</p>
          </section>

          <section style={{ marginTop: "30px" }}>
            <h2>Players</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
              {getTurnOrderedPlayers(players).map((player) => {
                const hand = getPlayerHand(player.id)
                const score = handValue(hand)

                return (
                  <div key={player.id} style={{ border: "1px solid #ddd", padding: "16px" }}>
                    <h3>{player.is_host ? "👑 " : "👤 "}{player.player_name}</h3>
                    <p>{hand.map(card => `[ ${card} ]`).join(" ") || "No cards"}</p>
                    <p>Score: {score}</p>
                    <p>Status: {getPlayerStatus(player)}</p>
                  </div>
                )
              })}
            </div>
          </section>

          {isCurrentTurn && !isRoundFinished && gameState?.status !== "dealer_turn" && (
            <section style={{ marginTop: "30px", textAlign: "center" }}>
              <h2>Host Turn Controls</h2>
              <button onClick={hit}>Hit</button>
              <button onClick={stand} style={{ marginLeft: "20px" }}>
                Stand
              </button>
            </section>
          )}

          <section style={{ marginTop: "30px" }}>
            <h2>Round Results</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{isRoundFinished ? message : "Round in progress"}</p>
          </section>

          <button onClick={leaveSession}>Back</button>
        </div>
      )
    }

    return (
      <div style={{ textAlign: "center", padding: "40px 20px", maxWidth: "420px", margin: "0 auto" }}>
        <h1>🃏 Blackjack</h1>
        <p>Room Code: <strong>{roomCode}</strong></p>

        <h2>Your Hand</h2>
        <p style={{ fontSize: "28px" }}>{playerHand.map(card => `[ ${card} ]`).join(" ")}</p>
        <p>Score: {handValue(playerHand)}</p>

        <h2>{turnMessage}</h2>
        {!isCurrentTurn && !isRoundFinished && (
          <p>Waiting for {waitingForPlayer?.player_name || currentTurnPlayer?.player_name || "the next player"}</p>
        )}

        {isRoundFinished ? (
          <div>
            <h2>Result</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>
              {getPlayerResult({ id: currentPlayerId, player_name: playerName }) || message}
            </p>
          </div>
        ) : (
          <div>
            <button onClick={hit} disabled={!isCurrentTurn}>Hit</button>
            <button onClick={stand} disabled={!isCurrentTurn} style={{ marginLeft: "20px" }}>
              Stand
            </button>
          </div>
        )}

        <br /><br />

        <button onClick={leaveSession}>Back</button>
      </div>
    )
  }

  return (
    <div style={{ textAlign: "center", paddingTop: "100px" }}>
      <h1>🎲 GameNightLab</h1>
      <p>Party Games for Friends and Family</p>

      <div style={{ marginTop: "40px" }}>
        <button onClick={createRoom}>Create Room</button>
        <button onClick={() => setScreen("join")} style={{ marginLeft: "20px" }}>
          Join Room
        </button>
      </div>
    </div>
  )
}

export default App
