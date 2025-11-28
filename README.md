# Real-Time_Multi-threaded_Application_Simulator
Developed a simulator to demonstrate multithreading models (e.g., Many-to-One, One-to-Many, Many-to-Many) and thread synchronization using semaphores and monitors. The simulator should visualize thread states and interactions, providing insights into thread management and CPU scheduling in multi-threaded environments
# README.md
# Part of OS Simulator Module

## 🌟 New: Web Application Version
A modern, interactive React-based version of this simulator is now available in the `web app/` directory. It features a "Neon Night" UI, real-time LWP visualization, and interactive tutorials.

[👉 Go to Web App Documentation](web%20app/README.md)

---

OS Simulator Code Analysis
1. Project Structure & Architecture
The project is structured as a modular Python application. Based on the imports found in main_window.py (e.g., from app.engine.scheduler import Scheduler), the files are intended to be organized into a specific package hierarchy, likely:

OS_Simulator/
├── main.py                   # The Entry Point (Run this file)
├── README.md                 # Project Documentation
├── requirements.txt          # Dependencies (e.g., tkinter is built-in, maybe 'pandas' later)
└── app/                      # Main Application Package
    ├── __init__.py
    ├── models/               # DATA LAYER
    │   ├── __init__.py
    │   └── thread_model.py   # Defines the Thread class (ID, State, Burst)
    ├── engine/               # LOGIC LAYER (Module A)
    │   ├── __init__.py
    │   └── scheduler.py      # Round Robin Logic, Tick System, Context Switching
    ├── ui/                   # GUI LAYER (Module B)
    │   ├── __init__.py
    │   ├── main_window.py    # Main Tkinter Window & Controls
    │   └── components.py     # Helper widgets (Queue frames, Thread Cards)
    └── analytics/            # DATA LAYER (Module C)
        ├── __init__.py
        └── logger.py         # Handles logs and Gantt history storage
Note: Several files (styles.py, logger.py, synchronizer.py, gantt_chart.py) are currently empty placeholders, suggesting that features like advanced styling, dedicated logging, thread synchronization (mutex/semaphores), and complex chart drawing were planned but not yet implemented.

2. Core Logic Analysis

A. Thread Model (thread_model.py)

This is a pure data class representing a Process Control Block (PCB).

Attributes: Stores id, burst_time, priority, state, and timing statistics.

History Tracking: Uniquely, it maintains a self.history list used to draw the Gantt chart later. This stores tuples of (start, end, state), allowing the UI to reconstruct the execution timeline.

B. The Scheduler Engine (scheduler.py)

This is the "brain" of the simulation.

Algorithm: It implements Round Robin (RR) scheduling.

Time Management: It does not run in real-time; instead, it uses a discrete "tick" system (next_tick()). Each tick represents 1 unit of time (e.g., 1 second or 1 cycle).

Lifecycle Logic:

Admission: Moves threads from NEW to READY.

Execution: Decrements remaining_time of the RUNNING thread.

Context Switching:

Termination: If remaining_time <= 0, state becomes TERMINATED.

Quantum Expiry: If current_quantum_counter >= time_quantum, the thread is preempted back to READY.

Dispatching: If the CPU is free, it picks the next thread from the READY queue. Observation: The dispatching logic currently uses a simple iteration (FIFO within the Ready list), which combined with the quantum preemption effectively creates Round Robin.

C. User Interface (main_window.py & components.py)

The UI is built using tkinter.

Visualization: It uses a grid layout to show "Queues" (Ready/Blocked) and the "CPU". Threads are drawn as "Cards" (draw_thread_card in components.py) with progress bars.

Simulation Loop: The run_loop method in MainWindow uses root.after(self.speed, self.run_loop) to trigger the scheduler's next_tick() method repeatedly. This decouples the UI refresh rate from the simulation logic.

Interactivity: Users can dynamically add threads, pause/resume execution, and manually block/unblock threads (simulating I/O interrupts).

3. Code Quality & Observations

Strengths

Separation of Concerns: The UI code (draw_thread_card) is distinct from the logic (Scheduler). The ThreadModel does not know about Tkinter, which is excellent design.

Visual Feedback: The application provides detailed feedback, including a real-time log box, progress bars on thread cards, and a Gantt chart drawn on a Canvas.

Robust State Handling: The scheduler handles edge cases like quantum expiry and manual I/O blocking effectively.

Areas for Improvement / Missing Features

Empty Modules: synchronizer.py is empty. Implementing this would allow simulation of Deadlocks or Race Conditions.

Priority Handling: While priority is stored in the ThreadModel, the current Scheduler implementation ignores it. It strictly follows Round Robin/FIFO. A future update could implement Priority Scheduling or Multilevel Feedback Queues.

Gantt Chart Refactoring: The Gantt drawing logic currently resides inside main_window.py. It should ideally be moved to the empty gantt_chart.py file to keep the main window class smaller.

4. Summary

This is a functional and well-structured foundation for an OS algorithm visualizer. It successfully demonstrates the mechanics of Context Switching, Time Slicing (Quantums), and Process States.
# app/models/thread_model.py
class ThreadModel:
    def __init__(self, t_id, burst, priority, arrival_time, color):
        self.id = t_id
        self.burst_time = burst
        self.remaining_time = burst
        self.priority = priority
        self.state = "NEW" 
        self.color = color
        self.arrival_time = arrival_time
        self.waiting_time = 0
        self.history = [] 
