# app/ui/components.py
import tkinter as tk

def create_queue_frame(parent, title, color, col_idx):
    """Creates a styled frame for Ready/Blocked queues"""
    frame = tk.Frame(parent, bg="white", bd=1, relief="solid")
    frame.grid(row=0, column=col_idx, sticky="nsew", padx=5)
    parent.columnconfigure(col_idx, weight=1)
    
    header = tk.Label(frame, text=title, bg=color, fg="white", font=("Segoe UI", 10, "bold"), pady=5)
    header.pack(fill="x")
    
    content = tk.Frame(frame, bg="white")
    content.pack(fill="both", expand=True, padx=5, pady=5)
    return content

def create_cpu_frame(parent, cpu_id):
    """Creates a specific frame for a single CPU Core"""
    container = tk.Frame(parent, bg="white", bd=1, relief="sunken", padx=5, pady=5)
    container.pack(fill="x", pady=5)
    
    lbl = tk.Label(container, text=f"CPU Core {cpu_id}", font=("Courier", 10, "bold"), fg="#312E81", bg="white")
    lbl.pack(anchor="w")
    
    content_area = tk.Frame(container, bg="white")
    content_area.pack(fill="x", pady=5)
    
    return container, content_area

def draw_thread_card(parent, thread, block_callback, unblock_callback):
    """Draws a single thread card inside a queue or CPU"""
    frame = tk.Frame(parent, bg="white", bd=1, relief="raised", padx=5, pady=5)
    frame.pack(fill="x", pady=2)
    
    # Header (ID and Priority)
    h_frame = tk.Frame(frame, bg="white")
    h_frame.pack(fill="x")
    tk.Label(h_frame, text=f"T{thread.id}", font=("Arial", 10, "bold"), fg=thread.color, bg="white").pack(side="left")
    tk.Label(h_frame, text=f"P:{thread.priority}", font=("Arial", 8), fg="gray", bg="white").pack(side="right")

    # Progress Bar
    if thread.burst_time > 0:
        pct = thread.remaining_time / thread.burst_time
        canvas = tk.Canvas(frame, height=5, bg="#E2E8F0", highlightthickness=0)
        canvas.pack(fill="x", pady=3)
        canvas.create_rectangle(0, 0, 150 * pct, 5, fill=thread.color, width=0)

    tk.Label(frame, text=f"{thread.remaining_time}ms left", font=("Arial", 8), bg="white").pack(anchor="w")
    
    # Interactive Buttons
    if thread.state == "RUNNING":
        btn = tk.Button(frame, text="Block IO", bg="#FECACA", fg="#DC2626", font=("Arial", 7), 
                        command=lambda: block_callback(thread.id))
        btn.pack(fill="x")
    elif thread.state == "BLOCKED":
        btn = tk.Button(frame, text="Unblock", bg="#BBF7D0", fg="#16A34A", font=("Arial", 7), 
                        command=lambda: unblock_callback(thread.id))
        btn.pack(fill="x")